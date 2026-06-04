import CapacityGuard from '../../lib/power/capacityGuard';
import { recordActivationAttemptStart } from '../../lib/plan/admission';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { steppedInputDevice } from '../utils/planTestUtils';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';

const emptyPendingStore = createPendingBinaryCommandStore({});

const buildDevice = (overrides: Partial<PlanInputDevice> = {}): PlanInputDevice => ({
  id: 'dev',
  name: 'Device',
  targets: [],
  currentOn: true,
  controllable: true,
  ...overrides,
});

describe('PlanBuilder overshoot diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T11:04:01.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs controlled and reducible load when overshoot is recoverable by control', async () => {
    const state = createPlanEngineState();

    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(2.5);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getDynamicSoftLimitOverride: () => 2.1,
      getShedBehavior: (deviceId: string) => (
        deviceId === 'at-temp'
          ? { action: 'set_temperature', temperature: 15, stepId: null }
          : { action: 'turn_off', temperature: null, stepId: null }
      ),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, state);

    await builder.buildDevicePlanSnapshot([
      buildDevice({
        id: 'reducible',
        name: 'Reducible',
        measuredPowerKw: 1.2,
      }),
      buildDevice({
        id: 'second',
        name: 'Second',
        measuredPowerKw: 0.9,
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      reasonCode: 'active_overshoot',
      totalKw: 2.5,
      hardCapBreached: false,
      hardCapHeadroomKw: 2.5,
      remainingReducibleControlledLoad: true,
      remainingReducibleControlledLoadW: 900,
      activeControlledDevices: 2,
      activePlannedShedDevices: 1,
      // Cold start: no prior plan baseline to diff against, so no device delta
      // could be computed and attribution is unavailable.
      overshootTotalDeltaKw: null,
      overshootUnattributedDeltaKw: null,
      overshootAttributionReason: 'no_previous_snapshot',
      overshootTopControlledContributors: [],
      overshootTopUncontrolledContributors: [],
    }));
  });

  it('reports all-below-epsilon attribution when no managed device rose past the epsilon', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: now }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 0.81,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      // First sample sits just over the soft limit but within the deadband, so the
      // overshoot is only pending (not yet actionable) and no entry is logged.
      capacityGuard.reportTotalPower(0.83);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'steady-device',
          name: 'Steady Device',
          measuredPowerKw: 0.83,
        }),
      ]);

      // After the persist window the pending overshoot becomes actionable, but the
      // device only crept up by 0.01 kW (under the 0.05 kW epsilon), so no contributor
      // qualifies and the whole rise stays below the epsilon.
      vi.advanceTimersByTime(21_000);
      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(0.84);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'steady-device',
          name: 'Steady Device',
          measuredPowerKw: 0.84,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.01,
        overshootAttributionReason: 'all_deltas_below_epsilon',
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports attribution_inputs_incomplete when a tracked device current power read drops to null', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      state.lastDeviceRestoreMs['flaky-device'] = now - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'flaky-device',
        source: 'pels_restore',
        nowTs: now - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 0.7,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      // First build: device reads a real measured value and total sits under the
      // soft limit, so a prior plan baseline (with a readable device) is recorded
      // and no overshoot fires.
      capacityGuard.reportTotalPower(0.5);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'flaky-device',
          name: 'Flaky Device',
          measuredPowerKw: 0.5,
        }),
      ]);

      // Second build: the whole-home total rises into overshoot, but the managed
      // device's own power read is now unavailable (no measured/expected/planning
      // value). It is excluded from the contributor diff, so its real rise lands in
      // the unattributed delta — which must NOT be blamed on background load.
      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(0.8);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'flaky-device',
          name: 'Flaky Device',
          currentOn: true,
          // measuredPowerKw intentionally omitted — the read failed this cycle.
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.3,
        overshootUnattributedDeltaKw: 0.3,
        overshootAttributionReason: 'attribution_inputs_incomplete',
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports attribution_inputs_incomplete when a managed device has a readable current but missing previous baseline', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 0.7,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      // First build: only the anchor device is known. This records a prior plan
      // baseline (total + tracked devices) but the newcomer below is absent, so it
      // will have NO previous snapshot to diff against next cycle.
      capacityGuard.reportTotalPower(0.5);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'anchor',
          name: 'Anchor',
          measuredPowerKw: 0.5,
        }),
      ]);

      // Second build: a newly discovered managed device appears with a perfectly
      // readable current power, while the anchor holds steady so the whole-home rise
      // is the newcomer's load. The newcomer cannot be diffed (no previous snapshot),
      // so it is dropped from contributors and its rise lands in the unattributed
      // delta — which must NOT be blamed on background load.
      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(0.8);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'anchor',
          name: 'Anchor',
          measuredPowerKw: 0.5,
        }),
        buildDevice({
          id: 'newcomer',
          name: 'Newcomer',
          measuredPowerKw: 0.3,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.3,
        overshootUnattributedDeltaKw: 0.3,
        overshootAttributionReason: 'attribution_inputs_incomplete',
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports attribution_inputs_incomplete when the current total is missing but a prior plan baseline exists', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      // A prior plan was already built this lifetime, so this is NOT a cold start.
      state.lastPlanBuiltAtMs = now - 30_000;

      const structuredLog = { info: vi.fn() };
      // Fresh guard that never received a finite total: getLastTotalPower() === null,
      // mimicking a transient/failed whole-home power read.
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        // Stale-but-present timestamp (> 10 min) drives the fail-closed freshness
        // state, which forces negative headroom and an actionable overshoot even
        // though the current total is null.
        getPowerTracker: () => ({ lastTimestamp: now - (11 * 60_000) }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 2.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'some-device',
          name: 'Some Device',
          measuredPowerKw: 0.5,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: null,
        overshootAttributionReason: 'attribution_inputs_incomplete',
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports attribution_inputs_incomplete on a fresh sample after a stale-hold previous (previous total null, baseline exists)', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      // Simulate the prior cycle having been a stale-hold / missing-total build:
      // `rememberPlanSnapshot` recorded a build timestamp (a baseline EXISTS) but the
      // total was null, so there is no previous total to diff a fresh sample against.
      state.lastPlanBuiltAtMs = now - 30_000;
      state.lastPlanTotalKw = null;

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        // Fresh power sample this cycle, so the current total IS a finite number — only
        // the PREVIOUS total is missing, which is what must drive power_sample_unavailable.
        getPowerTracker: () => ({ lastTimestamp: now }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 0.7,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      // A fresh finite total enters overshoot. Because the previous total is null, the
      // device delta cannot be computed (totalDeltaKw === null) even though THIS sample
      // is perfectly readable — a true cold start would have NO baseline at all.
      capacityGuard.reportTotalPower(0.8);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'some-device',
          name: 'Some Device',
          measuredPowerKw: 0.8,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: null,
        overshootAttributionReason: 'attribution_inputs_incomplete',
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs overshoot as exhausted when all shed candidates are already at minimum', async () => {
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });
    capacityGuard.reportTotalPower(4.8);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getShedBehavior: () => ({ action: 'set_temperature', temperature: 15, stepId: null }),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, state);

    await builder.buildDevicePlanSnapshot([
      buildDevice({
        id: 'at-temp',
        name: 'AtTemp',
        measuredPowerKw: 0.8,
        targets: [{ id: 'target_temperature', value: 15, unit: 'C' }],
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      reasonCode: 'active_overshoot',
      totalKw: 4.8,
      hardCapBreached: true,
      hardCapHeadroomKw: expect.closeTo(-0.8, 6),
      remainingReducibleControlledLoad: false,
      remainingReducibleControlledLoadW: 0,
      activeControlledDevices: 1,
      activePlannedShedDevices: 1,
    }));
  });

  it('sheds live measured stepped load during startup overshoot even when the current step is unknown', async () => {
    const now = new Date('2026-04-15T11:04:01.000Z').getTime();
    vi.setSystemTime(now);
    const state = createPlanEngineState();
    state.startupRestoreBlockedUntilMs = now + 60_000;
    state.lastDeviceControlledMs['step-live'] = now - (10 * 60_000);
    state.lastPlannedShedIds = new Set(['carryover-off']);

    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(4.461);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: now }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: (deviceId: string) => (deviceId === 'step-live' ? 100 : 10),
      getDynamicSoftLimitOverride: () => 2.0,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      structuredLog: { info: vi.fn() } as any,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, state);

    const plan = await builder.buildDevicePlanSnapshot([
      {
        ...steppedInputDevice({
          id: 'step-live',
          name: 'Connected 300',
          currentOn: true,
          currentState: 'on',
          measuredPowerKw: 1.671,
          expectedPowerKw: 1.25,
        }),
        selectedStepId: undefined,
        desiredStepId: undefined,
      },
      buildDevice({
        id: 'carryover-off',
        name: 'Carryover Off',
        currentOn: false,
        currentState: 'off',
        measuredPowerKw: 0,
        expectedPowerKw: 0,
      }),
    ]);

    const liveStepped = plan.devices.find((device) => device.id === 'step-live');
    expect(liveStepped?.plannedState).toBe('shed');
    expect(liveStepped?.reason.code).toBe('capacity');
  });

  it('does not emit a changed overshoot summary when same-sample skip keeps authority unchanged', async () => {
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(2.5);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: 500 }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getDynamicSoftLimitOverride: () => 2.1,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, state);

    const devices = [
      buildDevice({
        id: 'reducible',
        name: 'Reducible',
        measuredPowerKw: 1.2,
      }),
      buildDevice({
        id: 'second',
        name: 'Second',
        measuredPowerKw: 0.9,
      }),
    ];

    await builder.buildDevicePlanSnapshot(devices);
    await builder.buildDevicePlanSnapshot(devices);

    expect(structuredLog.info).toHaveBeenCalledTimes(1);
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      reasonCode: 'active_overshoot',
      hardCapBreached: false,
      remainingReducibleControlledLoad: true,
      activeControlledDevices: 2,
    }));
  });

  it('clamps overshoot duration to zero when the start timestamp is in the future', async () => {
    const state = createPlanEngineState();
    state.wasOvershoot = true;
    state.overshootLogged = true;
    state.overshootStartedMs = Date.now() + 5_000;

    const structuredLog = { info: vi.fn() };
    const capacityGuard = new CapacityGuard({ limitKw: 5, softMarginKw: 0 });
    capacityGuard.reportTotalPower(0.5);

    const builder = new PlanBuilder({
      homey: { settings: { set: vi.fn() } } as never,
      getCapacityGuard: () => capacityGuard,
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      getPowerTracker: () => ({ lastTimestamp: Date.now() }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getDynamicSoftLimitOverride: () => 2.1,
      getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
      structuredLog: structuredLog as any,
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: emptyPendingStore,
    }, state);

    await builder.buildDevicePlanSnapshot([
      buildDevice({
        id: 'device-1',
        name: 'Device',
        measuredPowerKw: 0.1,
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_cleared',
      durationMs: 0,
    }));
  });

  it('does not attribute overshoot when the total rise stays within the deadband', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      state.lastDeviceRestoreMs['deadband-device'] = now - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'deadband-device',
        source: 'pels_restore',
        nowTs: now - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });
      capacityGuard.reportTotalPower(4.8);

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: vi.fn()
          .mockReturnValueOnce(1.3)
          .mockReturnValueOnce(0.9),
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      const devices = [
        buildDevice({
          id: 'deadband-device',
          name: 'Deadband Device',
          measuredPowerKw: 1.03,
        }),
      ];

      capacityGuard.reportTotalPower(1.01);
      await builder.buildDevicePlanSnapshot(devices);

      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(1.03);
      await builder.buildDevicePlanSnapshot(devices);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.02,
      }));
      expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not attribute overshoot when the restored device is not a contributor', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      state.lastDeviceRestoreMs['restored-device'] = now - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-device',
        source: 'pels_restore',
        nowTs: now - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 0.7,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      const devices = [
        buildDevice({
          id: 'restored-device',
          name: 'Restored Device',
          measuredPowerKw: 0.5,
        }),
      ];

      capacityGuard.reportTotalPower(0.5);
      await builder.buildDevicePlanSnapshot(devices);

      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(0.8);
      await builder.buildDevicePlanSnapshot(devices);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.3,
        overshootUnattributedDeltaKw: 0.3,
        overshootAttributionReason: 'background_load_dominant',
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [],
      }));
      expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex case 1: a newly-discovered controllable device (no previous snapshot) whose
  // CURRENT power is 0/off cannot have caused the rise, so its undiffability is harmless
  // and must NOT suppress a genuine background_load_dominant verdict.
  it('reports background_load_dominant when an undiffable newcomer reads zero current power', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 0.7,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      // First build records a baseline with only the steady anchor; the newcomer below
      // is absent, so it will have NO previous snapshot to diff against next cycle.
      capacityGuard.reportTotalPower(0.5);
      await builder.buildDevicePlanSnapshot([
        buildDevice({ id: 'anchor', name: 'Anchor', measuredPowerKw: 0.5 }),
      ]);

      // Second build: the whole-home total rises to 0.8 (the rise lives in untracked
      // background load) while the anchor holds steady. A brand-new controllable device
      // appears, but it reads 0 W (off) — it could not have caused the rise, so its
      // missing previous snapshot is harmless and the verdict stays background-dominant.
      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(0.8);
      await builder.buildDevicePlanSnapshot([
        buildDevice({ id: 'anchor', name: 'Anchor', measuredPowerKw: 0.5 }),
        buildDevice({
          id: 'zero-newcomer',
          name: 'Zero Newcomer',
          currentOn: false,
          currentState: 'off',
          measuredPowerKw: 0,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.3,
        overshootUnattributedDeltaKw: 0.3,
        overshootAttributionReason: 'background_load_dominant',
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex case 2: an undiffable UNCONTROLLED tracked device (current reading above the
  // epsilon, no previous snapshot) is just as capable of being the real cause, so it
  // must block a confident background_load_dominant verdict — not be ignored.
  it('reports attribution_inputs_incomplete when an undiffable uncontrolled device could be the cause', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 0.7,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      // First build records a baseline with only the steady anchor.
      capacityGuard.reportTotalPower(0.5);
      await builder.buildDevicePlanSnapshot([
        buildDevice({ id: 'anchor', name: 'Anchor', measuredPowerKw: 0.5 }),
      ]);

      // Second build: a newly-discovered UNCONTROLLED device appears drawing 0.3 kW (above
      // the epsilon) with no previous snapshot. It is undiffable, so it is dropped from the
      // contributor diff and its real rise lands in the unattributed delta. Because an
      // uncontrolled device can be the real cause, this must NOT be blamed on background
      // load — it collapses to the honest incomplete reason.
      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(0.8);
      await builder.buildDevicePlanSnapshot([
        buildDevice({ id: 'anchor', name: 'Anchor', measuredPowerKw: 0.5 }),
        buildDevice({
          id: 'uncontrolled-newcomer',
          name: 'Uncontrolled Newcomer',
          controllable: false,
          measuredPowerKw: 0.3,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.3,
        overshootUnattributedDeltaKw: 0.3,
        overshootAttributionReason: 'attribution_inputs_incomplete',
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex case 3: under stale_fail_closed the CapacityGuard may still hold an old cached
  // total, so both context.total and the previous total are finite and a numeric (but
  // STALE) delta is produced. The freshness gate must reject this and report incomplete
  // rather than classify a confident cause from a stale delta.
  it('reports attribution_inputs_incomplete when the total delta is computed from a stale cached total', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      // A prior plan was already built this lifetime with a finite total, so a numeric
      // delta CAN be computed — this is not a cold start and not a null-total case.
      state.lastPlanBuiltAtMs = now - 30_000;
      state.lastPlanTotalKw = 0.5;

      const structuredLog = { info: vi.fn() };
      // Guard still holds an old cached total (getLastTotalPower stays finite) even
      // though the sample timestamp is now stale.
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });
      capacityGuard.reportTotalPower(0.8);

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        // Stale-but-present timestamp (> 10 min) drives the fail-closed freshness state,
        // which forces an actionable overshoot off the OLD cached total of 0.8.
        getPowerTracker: () => ({ lastTimestamp: now - (11 * 60_000) }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 0.7,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      await builder.buildDevicePlanSnapshot([
        buildDevice({ id: 'some-device', name: 'Some Device', measuredPowerKw: 0.5 }),
      ]);

      // Even though a finite total delta (0.8 - 0.5 = 0.3) COULD be computed, the sample
      // is stale (not fresh), so the delta is untrustworthy and the verdict is incomplete
      // rather than a confident background_load_dominant.
      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootAttributionReason: 'attribution_inputs_incomplete',
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [],
      }));
      expect(structuredLog.info).not.toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootAttributionReason: 'background_load_dominant',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('attributes overshoot when the restored device is a positive contributor', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);
      state.lastDeviceRestoreMs['restored-device'] = now - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-device',
        source: 'pels_restore',
        nowTs: now - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      capacityGuard.reportTotalPower(0.6);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-device',
          name: 'Restored Device',
          measuredPowerKw: 0.1,
        }),
      ]);

      structuredLog.info.mockClear();
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-device',
          name: 'Restored Device',
          measuredPowerKw: 0.7,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.7,
        overshootTopControlledContributors: [
          expect.objectContaining({
            deviceId: 'restored-device',
            deltaKw: 0.6,
          }),
        ],
      }));
      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-device',
        restoreAgeMs: 1_000,
        penaltyLevel: 1,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('attributes a delayed overshoot within the attribution window even after the device has shown initial load', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const start = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(start);
      state.lastDeviceRestoreMs['restored-thermostat'] = start - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-thermostat',
        source: 'pels_restore',
        nowTs: start - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      capacityGuard.reportTotalPower(0.4);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      capacityGuard.reportTotalPower(0.7);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      vi.setSystemTime(start + 20_000);
      capacityGuard.reportTotalPower(0.75);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 20_000,
        }),
      ]);

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 30_000);
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.8,
          lastFreshDataMs: start + 30_000,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 0.55,
      }));
      // Penalty-clear now happens at attribution-window expiry, not on the
      // first clean sample. A delayed overshoot at T+30s (within the 2-min
      // window) is still attributed back to the recently-restored device.
      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-thermostat',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps attribution open through a pending soft overshoot until a truly clean sample arrives', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const start = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(start);
      state.lastDeviceRestoreMs['restored-thermostat'] = start - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-thermostat',
        source: 'pels_restore',
        nowTs: start - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      capacityGuard.reportTotalPower(0.4);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      capacityGuard.reportTotalPower(0.7);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      vi.setSystemTime(start + 20_000);
      capacityGuard.reportTotalPower(1.03);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.25,
          lastFreshDataMs: start + 20_000,
        }),
      ]);

      expect(state.activationAttemptByDevice['restored-thermostat']).toMatchObject({
        startedMs: start - 1_000,
      });

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 30_000);
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.8,
          lastFreshDataMs: start + 30_000,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
      }));
      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-thermostat',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not close restore attribution on a stale-hold rebuild with non-negative synthetic headroom', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const start = new Date('2026-04-15T11:04:01.000Z').getTime();
      let lastTimestamp = start;
      vi.setSystemTime(start);
      state.lastDeviceRestoreMs['restored-thermostat'] = start - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-thermostat',
        source: 'pels_restore',
        nowTs: start - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      capacityGuard.reportTotalPower(0.4);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      lastTimestamp = start + 10_000;
      capacityGuard.reportTotalPower(0.7);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      lastTimestamp = start + 20_000;
      vi.setSystemTime(start + 90_000);
      capacityGuard.reportTotalPower(0.75);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      expect(state.activationAttemptByDevice['restored-thermostat']).toMatchObject({
        startedMs: start - 1_000,
      });

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 100_000);
      lastTimestamp = start + 100_000;
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          currentOn: true,
          measuredPowerKw: 0.8,
          lastFreshDataMs: start + 100_000,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-thermostat',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps attribution open when the only non-zero thermostat load is stale', async () => {
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const start = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(start);
      state.lastDeviceRestoreMs['restored-thermostat'] = start - 1_000;
      recordActivationAttemptStart({
        state,
        deviceId: 'restored-thermostat',
        source: 'pels_restore',
        nowTs: start - 1_000,
      });

      const structuredLog = { info: vi.fn() };
      const capacityGuard = new CapacityGuard({ limitKw: 4, softMarginKw: 0 });

      const builder = new PlanBuilder({
        homey: { settings: { set: vi.fn() } } as never,
        getCapacityGuard: () => capacityGuard,
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
        getPowerTracker: () => ({ lastTimestamp: Date.now() }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      capacityGuard.reportTotalPower(0.4);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      capacityGuard.reportTotalPower(0.7);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.2,
          observationStale: true,
          lastFreshDataMs: start - 5_000,
        }),
      ]);

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 20_000);
      capacityGuard.reportTotalPower(1.3);
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentOn: true,
          measuredPowerKw: 0.8,
          observationStale: true,
          lastFreshDataMs: start - 5_000,
        }),
      ]);

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_attributed',
        deviceId: 'restored-thermostat',
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
