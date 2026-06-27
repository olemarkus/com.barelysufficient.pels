// Integration test LOCKING that a managed, non-controllable, NON-TEMPERATURE home
// battery is EXCLUDED from every control path while still rising into the planner's
// device set (managed observe-only). It drives the REAL planner prep
// (`buildInitialPlanDevices`), the REAL surplus-absorb eligibility allocator
// (`resolveSurplusEligibility`), the REAL controlled/uncontrolled load-attribution
// split (`sumControlledUsageKw`/`splitControlledUsageKw`), the REAL shed candidate
// builder (`buildSheddingCandidates`), and the REAL starvation eligibility
// (`buildDeviceDiagnosticsObservations`) with a synthetic battery fixture
// (class:'battery', no temperature target, `managed: true`, `controllable: false`).
//
// Nothing internal is mocked — the existing gates (the `supportsTemperature` guard
// in `resolvePlannedTarget`, `controllable === false` in shedding, the
// `supportsTemperatureBoostDevice` surplus/boost filter, the starvation
// `controllable === true` + temperature requirement) are exactly what keeps the
// battery inert. These tests prove being managed+non-controllable+non-temperature is
// sufficient; no new control gate is added.
import { describe, expect, it } from 'vitest';
import { buildInitialPlanDevices } from '../../lib/plan/planDevices';
import type { PlanDevicesDeps } from '../../lib/plan/planDevices';
import { resolveSurplusEligibility } from '../../lib/plan/planSurplusAbsorb';
import { sumControlledUsageKw, splitControlledUsageKw } from '../../lib/plan/planUsage';
import { buildSheddingCandidates } from '../../lib/plan/shedding/candidates';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { buildDeviceDiagnosticsObservations } from '../../lib/plan/planDiagnostics';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { RestorePlanResult } from '../../lib/plan/restore';
import type { PlanContext } from '../../lib/plan/planContext';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import { buildPlanInputDevice } from '../utils/planTestUtils';

const BATTERY_ID = 'home-battery';
const HEATER_ID = 'heater';

// A managed observe-only home battery, exactly as the producer stamps it: managed,
// NON-controllable, class:'battery', and NO temperature target / control capability
// (a battery is not a temperature device). `measure_battery`/`measure_power` are
// device telemetry, not plan inputs, so they don't appear here.
const batteryInputDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice =>
  buildPlanInputDevice({
    id: BATTERY_ID,
    name: 'Home Battery',
    deviceClass: 'battery',
    deviceType: 'onoff',
    managed: true,
    controllable: false,
    // A battery has no control capability and no temperature target. The control
    // gates that keep it inert key on `controllable: false` + non-temperature, not
    // on the binary-control axis, so the default binary axis here is harmless.
    controlCapabilityId: undefined,
    targets: [],
    measuredPowerKw: 1.2, // charging at +1.2 kW (background usage)
    ...overrides,
  });

// A normal managed + controllable temperature heater, to prove the same harness
// DOES exercise control for a real device (so the battery exclusion isn't vacuous).
const heaterInputDevice = (): PlanInputDevice =>
  buildPlanInputDevice({
    id: HEATER_ID,
    name: 'Heater',
    deviceClass: 'heater',
    deviceType: 'temperature',
    managed: true,
    controllable: true,
    expectedPowerKw: 1.5,
    measuredPowerKw: 1.5,
    currentTemperature: 19,
    targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
  });

const buildContext = (devices: PlanInputDevice[], overrides: Partial<PlanContext> = {}): PlanContext => ({
  devices,
  desiredForMode: { [HEATER_ID]: 21 },
  total: 3,
  powerKnown: true,
  hasLivePowerSample: true,
  powerSampleAgeMs: 0,
  powerFreshnessState: 'fresh',
  hourBucketKey: '2025-01-01T00',
  softLimit: 2,
  capacitySoftLimit: 2,
  dailySoftLimit: null,
  softLimitSource: 'capacity',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: -1, // overshooting, so shedding WOULD fire for an eligible device
  headroom: -1,
  restoreMarginPlanning: 0.2,
  ...overrides,
});

// Minimal empty restore result — no device restored, no cooldown — sufficient for
// the starvation-eligibility probe (which never reads these fields for a battery).
const emptyRestoreResult: RestorePlanResult = {
  planDevices: [],
  stateUpdates: { swapByDevice: {} },
  restoredThisCycle: new Set<string>(),
  availableHeadroom: 1,
  restoredOneThisCycle: false,
  inCooldown: false,
  inRestoreCooldown: false,
  activeOvershoot: false,
  restoreCooldownSeconds: 0,
  shedCooldownRemainingSec: null,
  shedCooldownStartedAtMs: null,
  shedCooldownTotalSec: null,
  restoreCooldownRemainingSec: null,
  restoreCooldownStartedAtMs: null,
  restoreCooldownTotalSec: null,
  inShedWindow: false,
  restoreCooldownMs: 60 * 1000,
  lastRestoreCooldownBumpMs: null,
};

const defaultDeps: PlanDevicesDeps = {
  getPriorityForDevice: () => 100,
  getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
  isCurrentHourCheap: () => false,
  isCurrentHourExpensive: () => false,
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
};

describe('home battery as managed observe-only — control-path exclusion lock', () => {
  it('rides the planner device set but plans only "keep" with NO target (resolvePlannedTarget undefined)', () => {
    const planDevices = buildInitialPlanDevices({
      context: buildContext([batteryInputDevice()]),
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });

    const battery = planDevices.find((d) => d.id === BATTERY_ID);
    // Tracked: it IS in the built plan-device list (not dropped).
    expect(battery).toBeDefined();
    // Inert: keep, never shed; controllable:false carried through.
    expect(battery?.plannedState).toBe('keep');
    expect(battery?.controllable).toBe(false);
    // Non-temperature → no planned target the executor could actuate.
    expect(isTemperaturePlanDevice(battery!)).toBe(false);
  });

  it('receives no price-optimization write across cheap AND expensive hours (non-temperature)', () => {
    // Price optimization only ever writes a temperature setpoint; a battery has no
    // temperature target, so `resolvePlannedTarget` returns undefined regardless of
    // the price hour. Drive the REAL builder with price-opt ENABLED and a (nonsensical)
    // price-opt config for the battery, in BOTH a cheap and an expensive hour.
    const priceDeps = (cheap: boolean, expensive: boolean): PlanDevicesDeps => ({
      ...defaultDeps,
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => ({
        [BATTERY_ID]: { enabled: true, cheapDelta: 3, expensiveDelta: 3 },
      }),
      isCurrentHourCheap: () => cheap,
      isCurrentHourExpensive: () => expensive,
    });
    for (const [cheap, expensive] of [[true, false], [false, true]] as const) {
      const [battery] = buildInitialPlanDevices({
        context: buildContext([batteryInputDevice()]),
        state: createPlanEngineState(),
        shedSet: new Set(),
        shedReasons: new Map(),
        guardInShortfall: false,
        deps: priceDeps(cheap, expensive),
      });
      expect(battery.plannedState).toBe('keep');
      expect(isTemperaturePlanDevice(battery)).toBe(false);
      // No temperature target was resolved, so the executor has nothing to write.
      expect((battery as { plannedTarget?: number }).plannedTarget).toBeUndefined();
    }
  });

  it('is never a shed candidate even under capacity overshoot (controllable:false filtered out)', () => {
    const context = buildContext([batteryInputDevice(), heaterInputDevice()]);
    const { candidates } = buildSheddingCandidates({
      devices: context.devices,
      needed: 5, // ask for a large reduction so any eligible device is offered
      limitSource: 'capacity',
      total: context.total,
      capacitySoftLimit: context.capacitySoftLimit,
      state: createPlanEngineState(),
      deps: {
        capacityGuard: undefined,
        powerTracker: { lastTimestamp: 100 } as PowerTrackerState,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        getPriorityForDevice: () => 100,
        pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
        log: () => undefined,
      },
    });
    const candidateIds = candidates.map((c) => c.id);
    expect(candidateIds).not.toContain(BATTERY_ID);
    // The controllable heater IS a candidate — the exclusion isn't vacuous.
    expect(candidateIds).toContain(HEATER_ID);
  });

  it('is never surplus-absorb eligible (no temperature-boost target) even with export available', () => {
    const state = createPlanEngineState();
    resolveSurplusEligibility({
      devices: [batteryInputDevice()],
      state,
      signedNetKw: -3, // 3 kW export available
      powerKnown: true,
      // Even if a (nonsensical) surplus config were present, the temperature-boost
      // filter drops the battery before allocation.
      getConfig: () => ({ surplusWilling: true, surplusDelta: 2 }),
      getPriority: () => 1,
      nowTs: Date.UTC(2025, 0, 1, 12, 0, 0),
    });
    expect(state.surplusEligibilityByDevice[BATTERY_ID]).toBeUndefined();
  });

  it('is excluded from controlled (managed) load accounting — counts only as background usage', () => {
    const devices = [
      { id: BATTERY_ID, controllable: false, plannedState: 'keep' as const, measuredPowerKw: 1.2 },
      { id: HEATER_ID, controllable: true, plannedState: 'keep' as const, measuredPowerKw: 1.5 },
    ];
    // Only the heater's 1.5 kW is controlled usage; the battery's 1.2 kW is NOT.
    const controlledKw = sumControlledUsageKw(devices as Parameters<typeof sumControlledUsageKw>[0]);
    expect(controlledKw).toBeCloseTo(1.5, 5);

    // In the controlled/uncontrolled split the battery lands in the uncontrolled
    // (background) bucket — never double-counted as a managed/sheddable load.
    const { controlledKw: split, uncontrolledKw } = splitControlledUsageKw({
      devices: devices as Parameters<typeof splitControlledUsageKw>[0]['devices'],
      totalKw: 2.7, // 1.5 controlled + 1.2 background
    });
    expect(split).toBeCloseTo(1.5, 5);
    expect(uncontrolledKw).toBeCloseTo(1.2, 5);
  });

  it('is never starvation-eligible (fails the controllable:true + temperature requirement)', () => {
    const context = buildContext([batteryInputDevice({ measuredPowerKw: 0 })]);
    const planDevices = buildInitialPlanDevices({
      context,
      state: createPlanEngineState(),
      shedSet: new Set(),
      shedReasons: new Map(),
      guardInShortfall: false,
      deps: defaultDeps,
    });
    const observations = buildDeviceDiagnosticsObservations({
      context,
      planDevices,
      restoreResult: emptyRestoreResult,
      priceOptimizationEnabled: false,
      priceOptimizationSettings: {},
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
    });
    const batteryObservation = observations.find((o) => o.deviceId === BATTERY_ID);
    expect(batteryObservation?.eligibleForStarvation).toBe(false);
    expect(batteryObservation?.countingCause).toBeNull();
  });
});
