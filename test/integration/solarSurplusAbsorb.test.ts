// Integration test for SURPLUS-ABSORB: raising a willing thermostat's setpoint to
// self-consume exported solar.
//
// WHAT THIS PROBES: the planner prep layer end to end — the real
// `resolveSurplusEligibility` (priority allocator; hoisted to `planBuilder` in
// PR-7 and mirrored here by `buildDevices`) → `buildInitialPlanDevices` →
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
import { resolveSurplusEligibility } from '../../lib/plan/planSurplusAbsorb';
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
  planningTotalKw: signedNetKw,
  powerKnown: true,
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState: 'fresh',
  softLimit: 10,
  capacitySoftLimit: 10,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  budgetReleasableHeadroomHold: false,
  capacityHeadroomKw: 1,
  budgetHeadroomKw: null,
  hourBucketKey: '2026-01-15T12',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: 12,
  headroom: 12,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel: { cheap: false, expensive: false },
});

const deps = (surplusWilling: boolean, surplusDelta = SURPLUS_DELTA_C): PlanDevicesDeps => ({
  getPriorityForDevice: () => 100,
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
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

// Mirror the PR-7 hoist: `planBuilder.buildPlanSnapshotWithTimings` resolves
// surplus eligibility (the producer pass) right after the plan context exists,
// BEFORE materialization; `buildInitialPlanDevices` only READS the resulting
// state. This helper reproduces that exact ordering for the prep layer.
const buildDevices = (params: {
  context: PlanContext;
  state: PlanEngineState;
  deps: PlanDevicesDeps;
}) => {
  resolveSurplusEligibility({
    devices: params.context.devices,
    state: params.state,
    signedNetKw: params.context.planningTotalKw,
    getConfig: (deviceId) => params.deps.getPriceOptimizationSettings()[deviceId],
    getPriority: params.deps.getPriorityForDevice,
  });
  return buildInitialPlanDevices({
    context: params.context,
    state: params.state,
    shedSet: new Set(),
    shedReasons: new Map(),
    guardInShortfall: false,
    deps: params.deps,
  });
};

// One plan cycle at the current (faked) wall clock; returns the device's planned
// setpoint the executor would actuate.
const cycle = (
  state: PlanEngineState,
  signedNetKw: number,
  surplusWilling = true,
  measuredDrawKw = 0,
): number | undefined => {
  const device = buildDevices({
    context: buildContext(signedNetKw, measuredDrawKw),
    state,
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
) => buildDevices({
  context: buildContext(signedNetKw, measuredDrawKw),
  state,
  deps: deps(surplusWilling, surplusDelta),
})[0];

// `plannedTarget` lives on the temperature variant, so narrow before reading it.
const targetOf = (device: ReturnType<typeof cycleDevice>): number | undefined => (
  device && isTemperaturePlanDevice(device) ? device.plannedTarget : undefined
);

// One plan cycle with the whole-home power signal LOST (stale/unknown): the
// allocator's `powerOk` gate fails, which is a hard-off release condition.
const cyclePowerUnknown = (state: PlanEngineState): number | undefined => {
  const device = buildDevices({
    context: {
      ...buildContext(0),
      total: null,
      planningTotalKw: null,
      powerKnown: false,
      hasLivePowerSample: false,
      powerFreshnessState: 'stale_hold',
    },
    state,
    deps: deps(true),
  })[0];
  return device && isTemperaturePlanDevice(device) ? device.plannedTarget : undefined;
};

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

  it('releases early on sustained import beyond the hard-off bar, without waiting out the min dwell', () => {
    const state = createPlanEngineState();
    cycle(state, EXPORTING_KW);
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, EXPORTING_KW)).toBe(MODE_C + SURPLUS_DELTA_C);

    // Sun sets: sustained 1 kW import — unambiguously beyond the 0.35 kW hard-off bar.
    const importStart = SURPLUS_ABSORB_SETTLE_MS + 10_000;
    vi.setSystemTime(importStart);
    expect(cycle(state, IMPORTING_KW)).toBe(MODE_C + SURPLUS_DELTA_C); // settle still applies
    // One settle window into the import — far inside the 5-min dwell — the lift releases.
    const releaseAt = importStart + SURPLUS_ABSORB_SETTLE_MS;
    // Sanity: well before the dwell (engage at SETTLE + 5-min dwell) would allow it.
    expect(releaseAt).toBeLessThan(SURPLUS_ABSORB_SETTLE_MS + SURPLUS_ABSORB_MIN_DWELL_MS);
    vi.setSystemTime(releaseAt);
    expect(cycle(state, IMPORTING_KW)).toBe(MODE_C);
  });

  it('releases early when whole-home power goes unknown, without waiting out the min dwell', () => {
    const state = createPlanEngineState();
    cycle(state, EXPORTING_KW);
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, EXPORTING_KW)).toBe(MODE_C + SURPLUS_DELTA_C);

    // The meter goes stale: no surplus to allocate AND a hard-off condition.
    const lostAt = SURPLUS_ABSORB_SETTLE_MS + 10_000;
    vi.setSystemTime(lostAt);
    expect(cyclePowerUnknown(state)).toBe(MODE_C + SURPLUS_DELTA_C); // settle still applies
    vi.setSystemTime(lostAt + SURPLUS_ABSORB_SETTLE_MS);
    expect(cyclePowerUnknown(state)).toBe(MODE_C);
  });

  it('holds the dwell for a genuine dip: import below the hard-off bar releases only after the dwell', () => {
    const DIP_IMPORT_KW = 0.2; // below the 0.35 kW hard-off bar — a passing cloud
    const state = createPlanEngineState();
    cycle(state, EXPORTING_KW);
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, EXPORTING_KW)).toBe(MODE_C + SURPLUS_DELTA_C);

    const dipStart = SURPLUS_ABSORB_SETTLE_MS + 10_000;
    vi.setSystemTime(dipStart);
    expect(cycle(state, DIP_IMPORT_KW)).toBe(MODE_C + SURPLUS_DELTA_C);
    // One settle window into the dip — where a hard-off would already have
    // released — the min dwell still holds the lift (the passing-cloud pin).
    vi.setSystemTime(dipStart + SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, DIP_IMPORT_KW)).toBe(MODE_C + SURPLUS_DELTA_C);
    // Past the dwell (and the release settle) it drops back on the normal path.
    vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS + SURPLUS_ABSORB_MIN_DWELL_MS + SURPLUS_ABSORB_SETTLE_MS);
    expect(cycle(state, DIP_IMPORT_KW)).toBe(MODE_C);
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

  it('prunes the lift-active flag for a device that departed the snapshot', () => {
    const state = createPlanEngineState();
    // A device that engaged a lift and then left the snapshot would leave a stale
    // `surplusAbsorbActiveByDevice` flag (its per-cycle setter no longer runs), so
    // the curtailment estimator's `Object.values(...).some()` engaged-lift check
    // would report it forever. The eligibility cleanup must prune it too.
    state.surplusAbsorbActiveByDevice['ghost-device'] = true;
    cycle(state, EXPORTING_KW); // ghost-device is absent from this cycle's snapshot
    expect(state.surplusAbsorbActiveByDevice['ghost-device']).toBeUndefined();
  });

  describe('curtailment-inferred surplus (zero-export homes)', () => {
    // One plan cycle with the producer-resolved inferred term injected through
    // the same `PlanDevicesDeps` seam the app wires (`getInferredSurplusKw`).
    const cycleInferred = (
      state: PlanEngineState,
      signedNetKw: number,
      inferredSurplusKw: number | null,
      options: { powerKnown?: boolean; debugStructured?: (payload: Record<string, unknown>) => void } = {},
    ): number | undefined => {
      const powerKnown = options.powerKnown ?? true;
      const context: PlanContext = {
        ...buildContext(signedNetKw),
        ...(powerKnown ? {} : {
          total: null, planningTotalKw: null, powerKnown: false,
          hasLivePowerSample: false, powerFreshnessState: 'stale_hold' as const,
        }),
      };
      // Mirror the PR-7 hoist: the builder resolves surplus eligibility (with the
      // producer-injected inferred term + debug seam) BEFORE materialization;
      // `buildInitialPlanDevices` only reads the resulting state.
      resolveSurplusEligibility({
        devices: context.devices,
        state,
        signedNetKw: context.planningTotalKw,
        inferredSurplusKw,
        getConfig: (deviceId) => deps(true).getPriceOptimizationSettings()[deviceId],
        getPriority: deps(true).getPriorityForDevice,
        debugStructured: options.debugStructured,
      });
      const device = buildInitialPlanDevices({
        context,
        state,
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: deps(true),
      })[0];
      return device && isTemperaturePlanDevice(device) ? device.plannedTarget : undefined;
    };

    it('engages a willing thermostat at net~0 purely on the inferred term (the zero-export case)', () => {
      const state = createPlanEngineState();
      // Net pins ~0 (the inverter throttles); the producer infers 1.5 kW curtailed.
      expect(cycleInferred(state, 0, 1.5)).toBe(MODE_C); // settle window opens
      vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
      expect(cycleInferred(state, 0, 1.5)).toBe(MODE_C + SURPLUS_DELTA_C);
    });

    it('never lifts on the inferred term while whole-home power is unknown (powerOk gate unchanged)', () => {
      const state = createPlanEngineState();
      expect(cycleInferred(state, 0, 99, { powerKnown: false })).toBe(MODE_C);
      vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
      expect(cycleInferred(state, 0, 99, { powerKnown: false })).toBe(MODE_C);
    });

    it('sustained import releases the inferred lift without waiting out the dwell once the term zeroes', () => {
      const state = createPlanEngineState();
      cycleInferred(state, 0, 1.5);
      vi.setSystemTime(SURPLUS_ABSORB_SETTLE_MS);
      expect(cycleInferred(state, 0, 1.5)).toBe(MODE_C + SURPLUS_DELTA_C);
      // The inference was wrong: the lift forces real grid import. The producer's
      // import latch zeroes the term (this stub mirrors that — the producer gate
      // fires at 0.30, before the plan gate's 0.35 hard-off), the pool collapses,
      // and the sustained import hard-offs the release past the settle window,
      // far inside the 5-min dwell.
      const importAt = SURPLUS_ABSORB_SETTLE_MS + 10_000;
      vi.setSystemTime(importAt);
      expect(cycleInferred(state, IMPORTING_KW, null)).toBe(MODE_C + SURPLUS_DELTA_C); // settle applies
      vi.setSystemTime(importAt + SURPLUS_ABSORB_SETTLE_MS);
      expect(cycleInferred(state, IMPORTING_KW, null)).toBe(MODE_C);
      expect(importAt + SURPLUS_ABSORB_SETTLE_MS)
        .toBeLessThan(SURPLUS_ABSORB_SETTLE_MS + SURPLUS_ABSORB_MIN_DWELL_MS);
    });

    it('emits the surplus_pool composition record through the plan debug seam', () => {
      const state = createPlanEngineState();
      const records: Array<Record<string, unknown>> = [];
      cycleInferred(state, -0.5, 1.2, { debugStructured: (payload) => { records.push(payload); } });
      const pool = records.filter((r) => r.event === 'surplus_pool');
      expect(pool).toHaveLength(1);
      expect(pool[0]).toMatchObject({
        measuredExportKw: 0.5,
        addBackKw: 0,
        inferredSurplusKw: 1.2,
      });
      expect(pool[0]!.poolKw as number).toBeCloseTo(1.7, 6);
    });
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
      const built = buildDevices({
        context: ctx(),
        state,
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
