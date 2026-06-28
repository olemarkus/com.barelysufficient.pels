// Integration test for SURPLUS-ABSORB: raising a willing thermostat's setpoint to
// self-consume exported solar.
//
// WHAT THIS PROBES: the planner prep layer end to end — the real
// `buildInitialPlanDevices` → `resolveSurplusEligibility` (priority allocator) →
// `resolvePlannedTarget` → `applySurplusAbsorbDelta` → the real eligibility gate
// (`admission/surplusAbsorb`) → the real expected-draw resolver (`getRestoreDrawKw`),
// nothing internal mocked. The layer's outward seams are provided directly (the
// `PlanContext` carrying the signed whole-home net power a P1/HAN meter yields, the
// `PlanDevicesDeps`, and a faked clock); observation is the real output — the
// device's `plannedTarget` the executor would actuate. (A full createApp
// SDK-boundary e2e would additionally drive Homey Energy + the executor write.)
//
// KEY BEHAVIOURS: (1) a willing thermostat's setpoint lifts by `surplusDelta` once
// export persists past the settle window; (2) the overshoot-fit gate refuses to
// lift when export cannot cover the device's expected draw (so a raise never tips
// the home into import); (3) the lift releases back to baseline once export is
// gone past the min dwell; (4) a non-willing device never lifts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInitialPlanDevices } from '../../lib/plan/planDevices';
import type { PlanDevicesDeps } from '../../lib/plan/planDevices';
import { createPlanEngineState, type PlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import {
  SURPLUS_ABSORB_MIN_DWELL_MS,
  SURPLUS_ABSORB_SETTLE_MS,
} from '../../lib/plan/admission/surplusAbsorb';
import type { PlanContext } from '../../lib/plan/planContext';

const DEVICE_ID = 'tank';
const MODE_C = 20;
const SURPLUS_DELTA_C = 2;
const EXPECTED_DRAW_KW = 1.0; // gate engage bar = 1.0 + 0.25 reserve = 1.25 kW

// Exporting 2 kW (net = -2) clears the 1.25 kW engage bar; exporting 1 kW does not.
const EXPORTING_KW = -2;
const EXPORTING_TOO_LITTLE_KW = -1;
const IMPORTING_KW = 1;

const buildContext = (signedNetKw: number, measuredDrawKw = 0): PlanContext => ({
  devices: [
    buildPlanInputDevice({
      id: DEVICE_ID,
      name: 'Water tank',
      deviceType: 'temperature',
      currentTemperature: 50,
      expectedPowerKw: EXPECTED_DRAW_KW,
      measuredPowerKw: measuredDrawKw,
      targets: [{ id: 'target_temperature', value: MODE_C, unit: 'C', min: 0, max: 95, step: 0.5 }],
    }),
  ],
  desiredForMode: { [DEVICE_ID]: MODE_C },
  total: signedNetKw,
  powerKnown: true,
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState: 'fresh',
  softLimit: 10,
  capacitySoftLimit: 10,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  hourBucketKey: '2026-01-15T12',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: 12,
  headroom: 12,
  restoreMarginPlanning: 0.2,
});

const deps = (surplusWilling: boolean, surplusDelta = SURPLUS_DELTA_C): PlanDevicesDeps => ({
  getPriorityForDevice: () => 100,
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  isCurrentHourCheap: () => false,
  isCurrentHourExpensive: () => false,
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({
    [DEVICE_ID]: {
      enabled: false,
      cheapDelta: 0,
      expensiveDelta: 0,
      surplusWilling,
      surplusDelta,
    },
  }),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
});

// One plan cycle at the current (faked) wall clock; returns the device's planned
// setpoint the executor would actuate.
const cycle = (
  state: PlanEngineState,
  signedNetKw: number,
  surplusWilling = true,
  measuredDrawKw = 0,
): number | undefined => {
  const device = buildInitialPlanDevices({
    context: buildContext(signedNetKw, measuredDrawKw),
    state,
    shedSet: new Set(),
    shedReasons: new Map(),
    guardInShortfall: false,
    deps: deps(surplusWilling),
  })[0];
  return device && isTemperaturePlanDevice(device) ? device.plannedTarget : undefined;
};

// Same single cycle, but returns the whole plan device so the producer-resolved
// `surplusAbsorbActive` reason flag can be asserted alongside the planned target.
const cycleDevice = (
  state: PlanEngineState,
  signedNetKw: number,
  surplusWilling = true,
  measuredDrawKw = 0,
  surplusDelta = SURPLUS_DELTA_C,
) => buildInitialPlanDevices({
  context: buildContext(signedNetKw, measuredDrawKw),
  state,
  shedSet: new Set(),
  shedReasons: new Map(),
  guardInShortfall: false,
  deps: deps(surplusWilling, surplusDelta),
})[0];

// `plannedTarget` lives on the temperature variant, so narrow before reading it.
const targetOf = (device: ReturnType<typeof cycleDevice>): number | undefined => (
  device && isTemperaturePlanDevice(device) ? device.plannedTarget : undefined
);

describe('surplus-absorb setpoint raise (planner prep integration)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lifts a willing thermostat by surplusDelta once export persists past the settle window', () => {
    const state = createPlanEngineState();
    // First cycle opens the settle window but must not lift yet.
    expect(cycle(state, EXPORTING_KW)).toBe(MODE_C);
    // After the settle window, with export sustained, the setpoint lifts.
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, EXPORTING_KW)).toBe(MODE_C + SURPLUS_DELTA_C);
  });

  it('flags surplusAbsorbActive only while the lift is the binding cause', () => {
    // `surplusAbsorbActive` is a base field readable directly; `targetOf` narrows the target.
    const state = createPlanEngineState();
    // Importing: no lift, not active.
    const importing = cycleDevice(state, IMPORTING_KW);
    expect(targetOf(importing)).toBe(MODE_C);
    expect(importing?.surplusAbsorbActive).toBe(false);
    // First export cycle opens the settle window — still no lift, still not active.
    expect(cycleDevice(state, EXPORTING_KW)?.surplusAbsorbActive).toBe(false);
    // After the settle window the lift binds — the flag follows the actuated target.
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    const lifted = cycleDevice(state, EXPORTING_KW);
    expect(targetOf(lifted)).toBe(MODE_C + SURPLUS_DELTA_C);
    expect(lifted?.surplusAbsorbActive).toBe(true);
  });

  it('does NOT flag surplus when a sub-step delta rounds back to the original setpoint', () => {
    // The device target has step 0.5°C; a 0.2°C surplus lift normalizes back to MODE_C, so
    // the commanded target is identical to the no-solar target — surplus is not the binding
    // cause and the card must not claim "Raised to use your solar power".
    const SUB_STEP_DELTA = 0.2;
    const state = createPlanEngineState();
    cycleDevice(state, EXPORTING_KW, true, 0, SUB_STEP_DELTA); // open settle window
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    const rounded = cycleDevice(state, EXPORTING_KW, true, 0, SUB_STEP_DELTA);
    expect(targetOf(rounded)).toBe(MODE_C); // 20.2 → snapped to the 0.5 step → 20.0
    expect(rounded?.surplusAbsorbActive).toBe(false);
  });

  it('refuses to lift when export cannot cover the expected draw (overshoot-fit gate)', () => {
    const state = createPlanEngineState();
    expect(cycle(state, EXPORTING_TOO_LITTLE_KW)).toBe(MODE_C);
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, EXPORTING_TOO_LITTLE_KW)).toBe(MODE_C);
  });

  it('releases the lift back to baseline once export is gone past the min dwell', () => {
    const state = createPlanEngineState();
    cycle(state, EXPORTING_KW);
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, EXPORTING_KW)).toBe(MODE_C + SURPLUS_DELTA_C);

    // Cloud passes: now importing. The release condition has only just been
    // observed (its settle window has not elapsed, and the min dwell since engage
    // has not passed), so the lift holds.
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS + SURPLUS_ABSORB_MIN_DWELL_MS - 1);
    expect(cycle(state, IMPORTING_KW)).toBe(MODE_C + SURPLUS_DELTA_C);
    // ...then, past the dwell and once the release settles, it drops back.
    vi.setSystemTime(2 * SURPLUS_ABSORB_SETTLE_MS + SURPLUS_ABSORB_MIN_DWELL_MS);
    expect(cycle(state, IMPORTING_KW)).toBe(MODE_C);
  });

  it('holds the lift via own-draw add-back when the device consumes its own surplus', () => {
    const state = createPlanEngineState();
    cycle(state, EXPORTING_KW);
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, EXPORTING_KW)).toBe(MODE_C + SURPLUS_DELTA_C);

    // The thermostat now draws its ~1 kW element, pulling the home to net zero
    // export. Raw export is 0, but the device's own measured draw is added back
    // (and feeds getRestoreDrawKw), so the underlying surplus still covers the
    // expected draw → the lift holds rather than self-cancelling.
    vi.setSystemTime(2 * SURPLUS_ABSORB_SETTLE_MS + SURPLUS_ABSORB_MIN_DWELL_MS);
    expect(cycle(state, 0, true, EXPECTED_DRAW_KW)).toBe(MODE_C + SURPLUS_DELTA_C);
  });

  it('never lifts a non-willing device, even with ample export', () => {
    const state = createPlanEngineState();
    expect(cycle(state, EXPORTING_KW, false)).toBe(MODE_C);
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, EXPORTING_KW, false)).toBe(MODE_C);
  });

  it('clears stale eligibility when a device stops being a willing candidate', () => {
    const state = createPlanEngineState();
    cycle(state, EXPORTING_KW); // prime the settle window
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, EXPORTING_KW)).toBe(MODE_C + SURPLUS_DELTA_C);
    expect(state.surplusEligibilityByDevice[DEVICE_ID]).toBeDefined();

    // The device stops being willing — its latched eligibility must be dropped,
    // not held until the release window, so it cannot re-engage with no surplus.
    cycle(state, EXPORTING_KW, false);
    expect(state.surplusEligibilityByDevice[DEVICE_ID]).toBeUndefined();
  });

  it('reserves the surplus across devices: only the higher-priority one lifts when export covers one', () => {
    // Two willing ~1 kW heaters, exporting 1.5 kW — enough for one (1.0 + 0.25 reserve),
    // not two. Without cross-device reservation both would engage and oscillate.
    const HI = 'tank-hi';
    const LO = 'tank-lo';
    const makeDevice = (id: string) => buildPlanInputDevice({
      id,
      name: id,
      deviceType: 'temperature',
      currentTemperature: 50,
      expectedPowerKw: EXPECTED_DRAW_KW,
      targets: [{ id: 'target_temperature', value: MODE_C, unit: 'C', min: 0, max: 95, step: 0.5 }],
    });
    const surplusConfig = {
      enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true, surplusDelta: SURPLUS_DELTA_C,
    };
    const multiDeps: PlanDevicesDeps = {
      ...deps(true),
      // PELS priority `1` is top, so HI (1) outranks LO (100).
      getPriorityForDevice: (id) => (id === HI ? 1 : 100),
      getPriceOptimizationSettings: () => ({ [HI]: surplusConfig, [LO]: surplusConfig }),
    };
    const ctx = (): PlanContext => ({
      ...buildContext(-1.5),
      devices: [makeDevice(HI), makeDevice(LO)],
      desiredForMode: { [HI]: MODE_C, [LO]: MODE_C },
    });
    const state = createPlanEngineState();
    const run = () => {
      const built = buildInitialPlanDevices({
        context: ctx(),
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: multiDeps,
      });
      const targetOf = (id: string) => {
        const device = built.find((entry) => entry.id === id);
        return device && isTemperaturePlanDevice(device) ? device.plannedTarget : undefined;
      };
      return { hi: targetOf(HI), lo: targetOf(LO) };
    };

    run(); // prime the settle window
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    const after = run();
    expect(after.hi).toBe(MODE_C + SURPLUS_DELTA_C); // higher priority claims the surplus
    expect(after.lo).toBe(MODE_C); // lower priority left out — the pool is exhausted
  });
});
