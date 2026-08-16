import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { recordActivationAttemptStart } from '../../lib/plan/admission';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import type { PlanInputDevice, BinaryControlDiscriminantProbe } from '../../lib/plan/planTypes';
import { withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { fixtureCurrentDrawKw, resolveFixtureCurrentOn } from '../utils/planTestUtils';
import { fixtureResidualKw } from '../helpers/buildPlanInputDevice';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';

const emptyPendingStore = createPendingBinaryCommandStore({});

const buildDevice = (
  overrides: Partial<PlanInputDevice> & BinaryControlDiscriminantProbe = {},
): PlanInputDevice => {
  const merged = {
    id: 'dev',
    name: 'Device',
    targets: [],
    binaryControl: { on: true },
    controllable: true,
    binaryCapabilityId: 'onoff' as const,
    ...overrides,
  };
  return withBinaryDiscriminant({
    ...merged,
    currentDrawKw: fixtureCurrentDrawKw(merged),
    // Resolved for a turn_off shed, the producer's default. A fixture whose
    // shed is a setpoint move it is ALREADY at frees nothing, and must say so
    // by overriding `residualKw` — the consumer no longer re-derives it.
    residualKw: merged.residualKw
      ?? fixtureResidualKw({ ...merged, currentDrawKw: fixtureCurrentDrawKw(merged) }),
    currentOn: resolveFixtureCurrentOn(merged),
  }) as PlanInputDevice;
};

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
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    const lastPowerW = 2.5 * 1000;

    const builder = new PlanBuilder({
      getCapacityGuard: () => capacityGuard,
      setCapacityInShortfall: vi.fn(),
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
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
        currentDrawKw: 1.2,
        priority: 1,
      }),
      buildDevice({
        id: 'second',
        name: 'Second',
        currentDrawKw: 0.9,
        priority: 2,
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      reasonCode: 'active_overshoot',
      totalKw: 2.5,
      hardCapBreached: false,
      hardCapHeadroomKw: 2.5,
      remainingReducibleControlledLoad: true,
      // Equal stored priorities now resolve to a strict relative order before
      // shed selection. `second` is lower priority and is limited first, so the
      // higher-priority 1.2 kW device remains available.
      remainingReducibleControlledLoadW: 1200,
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
    let lastPowerW = 0;
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);

      const structuredLog = { info: vi.fn() };
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: now , lastPowerW }),
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
      lastPowerW = (0.83) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'steady-device',
          name: 'Steady Device',
          currentDrawKw: 0.83,
        }),
      ]);

      // After the persist window the pending overshoot becomes actionable, but the
      // device only crept up by 0.01 kW (under the 0.05 kW epsilon), so no contributor
      // qualifies and the whole rise stays below the epsilon.
      vi.advanceTimersByTime(21_000);
      structuredLog.info.mockClear();
      lastPowerW = (0.84) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'steady-device',
          name: 'Steady Device',
          currentDrawKw: 0.84,
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

  // Deleted: 'reports attribution_inputs_incomplete when a tracked device current
  // power read drops to null'. Its precondition — a managed device present in the
  // plan with no READABLE power — is no longer producible: the producer always
  // resolves a number, from the meter or from the declared load, so a device
  // cannot arrive unreadable. Disappearance is a different case, tracked in
  // TODO.md.
  it('reports attribution_inputs_incomplete when a managed device has a readable current but missing previous baseline', async () => {
    let lastPowerW = 0;
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);

      const structuredLog = { info: vi.fn() };
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
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
      lastPowerW = (0.5) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'anchor',
          name: 'Anchor',
          currentDrawKw: 0.5,
        }),
      ]);

      // Second build: a newly discovered managed device appears with a perfectly
      // readable current power, while the anchor holds steady so the whole-home rise
      // is the newcomer's load. The newcomer cannot be diffed (no previous snapshot),
      // so it is dropped from contributors and its rise lands in the unattributed
      // delta — which must NOT be blamed on background load.
      structuredLog.info.mockClear();
      lastPowerW = (0.8) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'anchor',
          name: 'Anchor',
          currentDrawKw: 0.5,
        }),
        buildDevice({
          id: 'newcomer',
          name: 'Newcomer',
          currentDrawKw: 0.3,
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
      // The tracker carries no `lastPowerW`, so the resolved total is null —
      // mimicking a transient/failed whole-home power read.
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
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
          currentDrawKw: 0.5,
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
    let lastPowerW = 0;
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
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        // Fresh power sample this cycle, so the current total IS a finite number — only
        // the PREVIOUS total is missing, which is what must drive power_sample_unavailable.
        getPowerTracker: () => ({ lastTimestamp: now , lastPowerW }),
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
      lastPowerW = (0.8) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'some-device',
          name: 'Some Device',
          currentDrawKw: 0.8,
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
    let lastPowerW = 0;
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    lastPowerW = (4.8) * 1000;

    const builder = new PlanBuilder({
      getCapacityGuard: () => capacityGuard,
      setCapacityInShortfall: vi.fn(),
      getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
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
        deviceType: 'temperature',
        currentDrawKw: 0.8,
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

  // Deleted with the consumer-modeled measured-step fallback: its premise was a
  // stepped device with NO known step, which the producer no longer emits
  // (`selectedStepId` is required on the stepped cluster). Live measured shed
  // for a device at a KNOWN step is covered by the step-ladder cases above.

  it('does not emit a changed overshoot summary when same-sample skip keeps authority unchanged', async () => {
    let lastPowerW = 0;
    const state = createPlanEngineState();
    const structuredLog = { info: vi.fn() };
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    lastPowerW = (2.5) * 1000;

    const builder = new PlanBuilder({
      getCapacityGuard: () => capacityGuard,
      setCapacityInShortfall: vi.fn(),
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => ({ lastTimestamp: 500 , lastPowerW }),
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
        currentDrawKw: 1.2,
        priority: 1,
      }),
      buildDevice({
        id: 'second',
        name: 'Second',
        currentDrawKw: 0.9,
        priority: 2,
      }),
    ];

    await builder.buildDevicePlanSnapshot(devices);
    await builder.buildDevicePlanSnapshot(devices);

    expect(structuredLog.info).toHaveBeenCalledTimes(1);
    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_entered',
      reasonCode: 'active_overshoot',
      hardCapBreached: false,
      // The lower-priority 0.9 kW device cannot cover the stale-power 1 kW
      // shortfall alone, so the strict order proceeds to the second device.
      remainingReducibleControlledLoad: false,
      activeControlledDevices: 2,
    }));
  });

  it('clamps overshoot duration to zero when the start timestamp is in the future', async () => {
    let lastPowerW = 0;
    const state = createPlanEngineState();
    state.wasOvershoot = true;
    state.overshootLogged = true;
    state.overshootStartedMs = Date.now() + 5_000;

    const structuredLog = { info: vi.fn() };
    const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
    lastPowerW = (0.5) * 1000;

    const builder = new PlanBuilder({
      getCapacityGuard: () => capacityGuard,
      setCapacityInShortfall: vi.fn(),
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
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
        currentDrawKw: 0.1,
      }),
    ]);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'overshoot_cleared',
      durationMs: 0,
    }));
  });

  it('does not attribute overshoot when the total rise stays within the deadband', async () => {
    let lastPowerW = 0;
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
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
      lastPowerW = (4.8) * 1000;

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
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
          currentDrawKw: 1.03,
        }),
      ];

      lastPowerW = (1.01) * 1000;
      await builder.buildDevicePlanSnapshot(devices);

      structuredLog.info.mockClear();
      lastPowerW = (1.03) * 1000;
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
    let lastPowerW = 0;
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
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
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
          currentDrawKw: 0.5,
        }),
      ];

      lastPowerW = (0.5) * 1000;
      await builder.buildDevicePlanSnapshot(devices);

      structuredLog.info.mockClear();
      lastPowerW = (0.8) * 1000;
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
    let lastPowerW = 0;
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);

      const structuredLog = { info: vi.fn() };
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
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
      lastPowerW = (0.5) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({ id: 'anchor', name: 'Anchor', currentDrawKw: 0.5 }),
      ]);

      // Second build: the whole-home total rises to 0.8 (the rise lives in untracked
      // background load) while the anchor holds steady. A brand-new controllable device
      // appears, but it reads 0 W (off) — it could not have caused the rise, so its
      // missing previous snapshot is harmless and the verdict stays background-dominant.
      structuredLog.info.mockClear();
      lastPowerW = (0.8) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({ id: 'anchor', name: 'Anchor', currentDrawKw: 0.5 }),
        buildDevice({
          id: 'zero-newcomer',
          name: 'Zero Newcomer',
          binaryControl: { on: false },
          currentState: 'off',
          currentDrawKw: 0,
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
    let lastPowerW = 0;
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);

      const structuredLog = { info: vi.fn() };
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
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
      lastPowerW = (0.5) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({ id: 'anchor', name: 'Anchor', currentDrawKw: 0.5 }),
      ]);

      // Second build: a newly-discovered UNCONTROLLED device appears drawing 0.3 kW (above
      // the epsilon) with no previous snapshot. It is undiffable, so it is dropped from the
      // contributor diff and its real rise lands in the unattributed delta. Because an
      // uncontrolled device can be the real cause, this must NOT be blamed on background
      // load — it collapses to the honest incomplete reason.
      structuredLog.info.mockClear();
      lastPowerW = (0.8) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({ id: 'anchor', name: 'Anchor', currentDrawKw: 0.5 }),
        buildDevice({
          id: 'uncontrolled-newcomer',
          name: 'Uncontrolled Newcomer',
          controllable: false,
          currentDrawKw: 0.3,
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
    let lastPowerW = 0;
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
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
      lastPowerW = (0.8) * 1000;

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        // Stale-but-present timestamp (> 10 min) drives the fail-closed freshness state,
        // which forces an actionable overshoot off the OLD cached total of 0.8.
        getPowerTracker: () => ({ lastTimestamp: now - (11 * 60_000) , lastPowerW }),
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
        buildDevice({ id: 'some-device', name: 'Some Device', currentDrawKw: 0.5 }),
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
    let lastPowerW = 0;
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
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      lastPowerW = (0.6) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-device',
          name: 'Restored Device',
          currentDrawKw: 0.1,
        }),
      ]);

      structuredLog.info.mockClear();
      lastPowerW = (1.3) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-device',
          name: 'Restored Device',
          currentDrawKw: 0.7,
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

  // The 2026-05-13 incident left contributor arrays empty even though tracked
  // background load carried the rise. An uncontrolled (controllable: false)
  // tracked device whose measured draw climbs above the attribution epsilon must
  // surface in `overshootTopUncontrolledContributors`, so the incident log names
  // the non-managed device that caused the breach rather than only reporting an
  // unattributed delta.
  it('surfaces a rising uncontrolled tracked device as an uncontrolled contributor', async () => {
    let lastPowerW = 0;
    vi.useFakeTimers();
    try {
      const state = createPlanEngineState();
      const now = new Date('2026-04-15T11:04:01.000Z').getTime();
      vi.setSystemTime(now);

      const structuredLog = { info: vi.fn() };
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      const buildDevices = (managedKw: number, backgroundKw: number): PlanInputDevice[] => [
        buildDevice({
          id: 'managed',
          name: 'Managed Heater',
          currentDrawKw: managedKw,
        }),
        buildDevice({
          id: 'background',
          name: 'Background Load',
          controllable: false,
          currentDrawKw: backgroundKw,
        }),
      ];

      lastPowerW = (0.6) * 1000;
      await builder.buildDevicePlanSnapshot(buildDevices(0.3, 0.3));

      structuredLog.info.mockClear();
      // The uncontrolled device climbs 0.3 -> 1.5 kW (+1.2) while the managed
      // device holds, so the rise is owned by tracked background load.
      lastPowerW = (1.8) * 1000;
      await builder.buildDevicePlanSnapshot(buildDevices(0.3, 1.5));

      expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
        event: 'overshoot_entered',
        overshootTotalDeltaKw: 1.2,
        overshootAttributionReason: null,
        overshootTopControlledContributors: [],
        overshootTopUncontrolledContributors: [
          expect.objectContaining({
            deviceId: 'background',
            deviceName: 'Background Load',
            controllable: false,
            deltaKw: 1.2,
          }),
        ],
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('attributes a delayed overshoot within the attribution window even after the device has shown initial load', async () => {
    let lastPowerW = 0;
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
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      lastPowerW = (0.4) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          binaryControl: { on: true },
          currentDrawKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      lastPowerW = (0.7) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          binaryControl: { on: true },
          currentDrawKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      vi.setSystemTime(start + 20_000);
      lastPowerW = (0.75) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          binaryControl: { on: true },
          currentDrawKw: 0.2,
          lastFreshDataMs: start + 20_000,
        }),
      ]);

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 30_000);
      lastPowerW = (1.3) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          binaryControl: { on: true },
          currentDrawKw: 0.8,
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
    let lastPowerW = 0;
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
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      lastPowerW = (0.4) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          binaryControl: { on: true },
          currentDrawKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      lastPowerW = (0.7) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          binaryControl: { on: true },
          currentDrawKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      vi.setSystemTime(start + 20_000);
      lastPowerW = (1.03) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          binaryControl: { on: true },
          currentDrawKw: 0.25,
          lastFreshDataMs: start + 20_000,
        }),
      ]);

      expect(state.activationAttemptByDevice['restored-thermostat']).toMatchObject({
        startedMs: start - 1_000,
      });

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 30_000);
      lastPowerW = (1.3) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          binaryControl: { on: true },
          currentDrawKw: 0.8,
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
    let lastPowerW = 0;
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
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp , lastPowerW }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      lastPowerW = (0.4) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          binaryControl: { on: true },
          currentDrawKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      lastTimestamp = start + 10_000;
      lastPowerW = (0.7) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          binaryControl: { on: true },
          currentDrawKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      lastTimestamp = start + 20_000;
      vi.setSystemTime(start + 90_000);
      lastPowerW = (0.75) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          binaryControl: { on: true },
          currentDrawKw: 0.2,
          lastFreshDataMs: start + 10_000,
        }),
      ]);

      expect(state.activationAttemptByDevice['restored-thermostat']).toMatchObject({
        startedMs: start - 1_000,
      });

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 100_000);
      lastTimestamp = start + 100_000;
      lastPowerW = (1.3) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          currentState: 'on',
          binaryControl: { on: true },
          currentDrawKw: 0.8,
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
    let lastPowerW = 0;
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
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 4, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => ({ lastTimestamp: Date.now() , lastPowerW }),
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: () => 100,
        getDynamicSoftLimitOverride: () => 1.0,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: structuredLog as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      lastPowerW = (0.4) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          binaryControl: { on: true },
          currentDrawKw: 0,
        }),
      ]);

      vi.setSystemTime(start + 10_000);
      lastPowerW = (0.7) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          binaryControl: { on: true },
          currentDrawKw: 0.2,
          lastFreshDataMs: start - 5_000,
        }),
      ]);

      structuredLog.info.mockClear();

      vi.setSystemTime(start + 20_000);
      lastPowerW = (1.3) * 1000;
      await builder.buildDevicePlanSnapshot([
        buildDevice({
          id: 'restored-thermostat',
          name: 'Restored Thermostat',
          deviceClass: 'thermostat',
          binaryControl: { on: true },
          currentDrawKw: 0.8,
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

  // Field incident 2026-08-01, through the REAL builder lifecycle: the shedding
  // pass runs before `updateOvershootState`, so the hold's anchor has to survive
  // the overshoot-entry branch that nulls the mitigation clock. Driving
  // `buildSheddingPlan` directly cannot see this ordering.
  it('does not deepen past the first shed when the next poll repeats the same watts', async () => {
    vi.useFakeTimers();
    try {
      const start = new Date('2026-04-15T11:03:44.000Z').getTime();
      vi.setSystemTime(start);
      const state = createPlanEngineState();
      const capacityGuard = createTestCapacityGuard({ homeId: 'main' });
      // Priority 1 is the most protected device; 4 sheds first.
      const priorities: Record<string, number> = { protected: 1, mid: 2, heater: 4 };
      const powerTracker = { lastTimestamp: start, lastPowerW: 4_351 };

      const builder = new PlanBuilder({
        getCapacityGuard: () => capacityGuard,
        setCapacityInShortfall: vi.fn(),
        getCapacitySettings: () => ({ limitKw: 3, marginKw: 0 }),
        getOperatingMode: () => 'Home',
        getModeDeviceTargets: () => ({}),
        getPriceOptimizationEnabled: () => false,
        getPriceOptimizationSettings: () => ({}),
        getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
        getPowerTracker: () => powerTracker,
        getDailyBudgetSnapshot: () => null,
        getPriorityForDevice: (deviceId: string) => priorities[deviceId] ?? 100,
        getDynamicSoftLimitOverride: () => 2.538,
        getShedBehavior: () => ({ action: 'turn_off', temperature: null, stepId: null }),
        structuredLog: { info: vi.fn() } as any,
        log: vi.fn(),
        logDebug: vi.fn(),
        pendingBinaryCommandStore: emptyPendingStore,
      }, state);

      const devices = (heaterOn: boolean) => [
        buildDevice({ id: 'protected', name: 'Protected', currentDrawKw: 0.53 }),
        buildDevice({ id: 'mid', name: 'Mid', currentDrawKw: 1.3 }),
        // Metered water heater: drawing 2 kW while on, its own honest 0 when off.
        buildDevice({
          id: 'heater',
          name: 'Heater',
          expectedPowerKw: 2,
          binaryControl: { on: heaterOn },
          currentDrawKw: heaterOn ? 2 : 0,
        }),
      ];

      powerTracker.lastPowerW = 4.351 * 1000;
      const first = await builder.buildDevicePlanSnapshot(devices(true));
      expect(first.devices.filter((d) => d.plannedState === 'shed').map((d) => d.id)).toEqual(['heater']);

      // 10 s later the meter re-delivers the identical reading: the heater is off
      // but its relief has not surfaced yet. Deepening here is what took the
      // user's #1 device in the field.
      vi.setSystemTime(start + 10_000);
      powerTracker.lastTimestamp = start + 10_000;
      powerTracker.lastPowerW = 4.351 * 1000;
      const second = await builder.buildDevicePlanSnapshot(devices(false));

      const shedIds = second.devices.filter((d) => d.plannedState === 'shed').map((d) => d.id);
      expect(shedIds).not.toContain('protected');
      expect(shedIds).not.toContain('mid');
    } finally {
      vi.useRealTimers();
    }
  });
});
