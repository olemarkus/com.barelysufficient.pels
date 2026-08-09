import {
  AppDeviceControlHelpers,
  STEPPED_LOAD_COMMAND_STALE_MS,
  buildControlModelMap,
  createDeviceControlRuntimeState,
  decorateSnapshotWithDeviceControl,
  markSteppedLoadDesiredStepIssued,
  normalizeStoredDeviceControlProfiles,
  pruneStaleSteppedLoadCommandStates,
  resolveEffectiveSteppedLoadProfile,
  reportSteppedLoadActualStep,
  resolveDefaultControlModel,
} from '../../setup/appDeviceControlHelpers';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { resolveCurrentOn } from '../../lib/observer/observedState';
import type {
  DeviceControlProfiles,
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDecoration,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import {
  buildEvTargetPowerCandidateProfile,
  buildTargetPowerReachabilityState,
  type TargetPowerConfigWithReachability,
} from '../../lib/device/targetPowerReachability';

const steppedProfiles: DeviceControlProfiles = {
  'dev-1': {
    model: 'stepped_load',
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 1250 },
      { id: 'max', planningPowerW: 3000 },
    ],
  },
};

const baseSnapshot = (
  // `SteppedLoadDecoration` fields (e.g. `selectedStepId`) are not part of the
  // raw `TargetDeviceSnapshot`; tests seed them to assert the decorator ignores
  // any persisted decoration on its input. They flow through the spread and the
  // return is still a plain `TargetDeviceSnapshot`.
  overrides: Partial<
    TargetDeviceSnapshot & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe
  > & Partial<SteppedLoadDecoration> = {},
): TargetDeviceSnapshot & MeasuredPowerObservedProbe
  & SteppedLoadDescriptorProbe & ReportedStepObservedProbe => ({
  id: 'dev-1',
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Water heater',
  targets: [],
  deviceType: 'onoff',
  binaryControl: { on: false },
  measuredPowerKw: 0,
  ...overrides,
});

describe('appDeviceControlHelpers', () => {
  it('learns a settled EV ceiling and ends the foreground retry lifecycle', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({
        config: baseConfig,
        maxReachedPowerW: 5750,
      }),
    };
    const snapshot = baseSnapshot({
      name: 'EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: buildEvTargetPowerCandidateProfile(config),
      targetPowerConfig: config,
      reportedStepId: '24a',
      reportedStepPowerW: 5750,
      reportedStepObservedAtMs: 1500,
    });
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getTargetPowerConfig: () => config,
      updateTargetPowerReachability: (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      },
      getDeviceSnapshots: () => [snapshot],
      getStructuredLogger: () => ({ info: vi.fn(), warn: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      issuedAtMs: 1000,
      pendingWindowMs: 100,
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2000);

    helpers.reconcileTargetPowerReachability([snapshot], 2_000);
    const [decorated] = helpers.decorateTargetSnapshotList([snapshot]);

    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 5750,
      probeFailureCount: 1,
      nextProbeAtMs: 902_000,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
    expect(decorated.steppedLoadProfile?.steps.at(-1)?.id).toBe('25a');
    expect(decorated.targetPowerConfig).toEqual(baseConfig);
    dateNow.mockRestore();
  });

  it('raises the confirmed ladder when a probe reaches its requested step', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({
        config: baseConfig,
        maxReachedPowerW: 5750,
        probeFailureCount: 2,
        nextProbeAtMs: 1000,
      }),
    };
    const snapshot = baseSnapshot({
      name: 'EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: buildEvTargetPowerCandidateProfile(config),
      targetPowerConfig: config,
      reportedStepId: '25a',
      reportedStepPowerW: 5750,
      reportedStepObservedAtMs: 500,
    });
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getTargetPowerConfig: () => config,
      updateTargetPowerReachability: (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      },
      getDeviceSnapshots: () => [snapshot],
      getStructuredLogger: () => ({ info: vi.fn(), warn: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1000,
      pendingWindowMs: 100,
    });
    snapshot.reportedStepPowerW = 6440;
    snapshot.reportedStepObservedAtMs = 1500;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1600);

    helpers.reconcileTargetPowerReachability([snapshot], 1_600);
    const [decorated] = helpers.decorateTargetSnapshotList([snapshot]);

    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 6440,
      probeFailureCount: 0,
    });
    expect(config.reachability).not.toHaveProperty('nextProbeAtMs');
    expect(decorated.reportedStepId).toBe('28a');
    expect(decorated.steppedLoadProfile?.steps.at(-1)?.id).toBe('28a');
    dateNow.mockRestore();
  });

  it('finalizes a refused Flow-backed probe from repeated exact feedback', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({
        config: baseConfig,
        maxReachedPowerW: 5750,
      }),
    };
    const snapshot = baseSnapshot({
      name: 'Flow EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: buildEvTargetPowerCandidateProfile(config),
      targetPowerConfig: config,
    });
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getTargetPowerConfig: () => config,
      updateTargetPowerReachability: (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      },
      reportFlowSteppedLoadObservation: ({ stepId, planningPowerW, observedAtMs }) => {
        snapshot.reportedStepId = stepId;
        snapshot.reportedStepPowerW = planningPowerW;
        snapshot.reportedStepObservedAtMs = observedAtMs;
        return true;
      },
      getDeviceSnapshots: () => [snapshot],
      getStructuredLogger: () => ({ info: vi.fn(), warn: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1000,
      pendingWindowMs: 100,
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2000);

    helpers.decorateTargetSnapshotList([snapshot]);
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')?.status).toBe('stale');
    expect(helpers.reportSteppedLoadActualStep('dev-1', '25a')).toBe('changed');
    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 5750,
      probeFailureCount: 1,
      nextProbeAtMs: 902_000,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
    dateNow.mockRestore();
  });

  it('does not lower learned reachability after a successful downward command', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7360,
    };
    const reachability = buildTargetPowerReachabilityState({
      config: baseConfig,
      maxReachedPowerW: 5750,
      probeFailureCount: 1,
      nextProbeAtMs: 900_000,
    });
    const config: TargetPowerConfigWithReachability = { ...baseConfig, reachability };
    const updateTargetPowerReachability = vi.fn(() => true);
    const snapshot = baseSnapshot({
      name: 'EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: buildEvTargetPowerCandidateProfile(config),
      targetPowerConfig: config,
      reportedStepId: '24a',
      reportedStepPowerW: 5520,
      reportedStepObservedAtMs: 1500,
    });
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getTargetPowerConfig: () => config,
      updateTargetPowerReachability,
      getDeviceSnapshots: () => [snapshot],
      getStructuredLogger: () => ({ info: vi.fn(), warn: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '24a',
      previousStepId: '25a',
      issuedAtMs: 1000,
      pendingWindowMs: 100,
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2000);

    helpers.reconcileTargetPowerReachability([snapshot], 2_000);

    expect(updateTargetPowerReachability).not.toHaveBeenCalled();
    expect(config.reachability).toBe(reachability);
    dateNow.mockRestore();
  });

  it('does not classify an ordinary increase inside the confirmed ladder as a probe', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    const config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 7_360 }),
    };
    const updateTargetPowerReachability = vi.fn(() => true);
    const snapshot = baseSnapshot({
      name: 'EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: buildEvTargetPowerCandidateProfile(config),
      targetPowerConfig: config,
      reportedStepPowerW: 1_380,
      reportedStepObservedAtMs: 1_500,
    });
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getTargetPowerConfig: () => config,
      updateTargetPowerReachability,
      getDeviceSnapshots: () => [snapshot],
      getStructuredLogger: () => ({ info: vi.fn(), warn: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '16a',
      previousStepId: '6a',
      issuedAtMs: 1_000,
      pendingWindowMs: 100,
    });
    helpers.reconcileTargetPowerReachability([snapshot], 2_000);

    expect(updateTargetPowerReachability).not.toHaveBeenCalled();
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: '16a',
      pending: true,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1'))
      .not.toHaveProperty('targetPowerProbeConfirmedMaxPowerW');
  });

  it('moves a silent refused probe to background backoff without lowering its proven maximum', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 5_750 }),
    };
    const snapshot = baseSnapshot({
      name: 'Quiet EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: buildEvTargetPowerCandidateProfile(config),
      targetPowerConfig: config,
      reportedStepPowerW: 5_750,
      reportedStepObservedAtMs: 500,
    });
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getTargetPowerConfig: () => config,
      updateTargetPowerReachability: (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      },
      getDeviceSnapshots: () => [snapshot],
      getStructuredLogger: () => ({ info: vi.fn(), warn: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_000,
      pendingWindowMs: 100,
    });
    helpers.reconcileTargetPowerReachability([snapshot], 2_000);

    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 5_750,
      probeFailureCount: 1,
      nextProbeAtMs: 902_000,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
  });

  it('ends a refused foreground probe even when its reachability update reports no change', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    const config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({
        config: baseConfig,
        maxReachedPowerW: 5_750,
      }),
    };
    const snapshot = baseSnapshot({
      name: 'Quiet EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: buildEvTargetPowerCandidateProfile(config),
      targetPowerConfig: config,
      reportedStepPowerW: 5_750,
      reportedStepObservedAtMs: 500,
    });
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getTargetPowerConfig: () => config,
      updateTargetPowerReachability: vi.fn(() => false),
      getDeviceSnapshots: () => [snapshot],
      getStructuredLogger: () => ({ info: vi.fn(), warn: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_000,
      pendingWindowMs: 100,
    });
    helpers.reconcileTargetPowerReachability([snapshot], 2_000);

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
  });

  it('keeps a probe settlement anchored to its first issue across command retries', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 5_750 }),
    };
    const scheduleTargetPowerProbeSettlement = vi.fn();
    const snapshot = baseSnapshot({
      name: 'Quiet EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: buildEvTargetPowerCandidateProfile(config),
      targetPowerConfig: config,
      reportedStepPowerW: 5_750,
      reportedStepObservedAtMs: 500,
    });
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getTargetPowerConfig: () => config,
      updateTargetPowerReachability: (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      },
      scheduleTargetPowerProbeSettlement,
      getDeviceSnapshots: () => [snapshot],
      getStructuredLogger: () => ({ info: vi.fn(), warn: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_000,
      pendingWindowMs: 100,
    });
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: '28a',
      previousStepId: '25a',
      issuedAtMs: 1_050,
      pendingWindowMs: 100,
    });

    expect(scheduleTargetPowerProbeSettlement).toHaveBeenNthCalledWith(1, 1_100);
    expect(scheduleTargetPowerProbeSettlement).toHaveBeenNthCalledWith(2, 1_100);
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      lastIssuedAtMs: 1_050,
      targetPowerProbeStartedAtMs: 1_000,
      retryCount: 1,
    });

    helpers.reconcileTargetPowerReachability([snapshot], 1_100);
    expect(config.reachability).toMatchObject({
      maxReachedPowerW: 5_750,
      probeFailureCount: 1,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
  });

  it('prefers newer Flow exact feedback when native control is not authoritative', () => {
    const baseConfig: TargetPowerSteppedLoadConfig = {
      enabled: true,
      preset: 'ev_charger_1_phase',
      max: 7_360,
    };
    let config: TargetPowerConfigWithReachability = {
      ...baseConfig,
      reachability: buildTargetPowerReachabilityState({ config: baseConfig, maxReachedPowerW: 5_520 }),
    };
    const snapshot = baseSnapshot({
      name: 'Flow EV charger',
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: buildEvTargetPowerCandidateProfile(config),
      targetPowerConfig: config,
      reportedStepPowerW: 5_520,
      reportedStepObservedAtMs: 500,
    });
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getTargetPowerConfig: () => config,
      updateTargetPowerReachability: (_deviceId, reachability) => {
        config = { ...config, reachability };
        return true;
      },
      reportFlowSteppedLoadObservation: ({ stepId, planningPowerW, observedAtMs }) => {
        snapshot.reportedStepId = stepId;
        snapshot.reportedStepPowerW = planningPowerW;
        snapshot.reportedStepObservedAtMs = observedAtMs;
        return true;
      },
      getDeviceSnapshots: () => [snapshot],
      getStructuredLogger: () => ({ info: vi.fn(), warn: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2_000);

    expect(helpers.reportSteppedLoadActualStep('dev-1', '25a')).toBe('changed');

    expect(config.reachability?.maxReachedPowerW).toBe(5_750);
    dateNow.mockRestore();
  });

  it('tracks optimistic lowest-step initialization without entering the retry lifecycle', () => {
    const runtimeState = createDeviceControlRuntimeState();

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'low',
      issuedAtMs: 1_000,
      confirmationPolicy: 'assume_applied',
    });

    expect(runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.get('dev-1')).toBe('low');
    expect(runtimeState.steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
    expect(pruneStaleSteppedLoadCommandStates(runtimeState, 1_000_000)).toBe(false);

    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: true } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 2_000,
    });

    expect(decorated).toMatchObject({
      reportedStepId: undefined,
      selectedStepId: 'low',
      stepCommandPending: false,
      stepCommandStatus: 'idle',
    });
  });

  it('does not treat preserved planner intent as issued command history', () => {
    let profiles = steppedProfiles;
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => profiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: true } })],
      getLatestPlanSnapshot: () => ({
        devices: [{ id: 'dev-1', targetStepId: 'low', desiredStepId: 'low' }],
      } as never),
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'low',
      status: 'idle',
    });

    profiles = {
      'dev-1': {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
        ],
      },
    };

    expect(helpers.getSteppedLoadCommandSession('dev-1')).toEqual({
      initializationAssumedStepId: undefined,
      hasPriorStepCommand: false,
      reportedStepId: undefined,
    });
  });

  it('clears the ended on-session before an unknown-level device turns on again', () => {
    const runtimeState = createDeviceControlRuntimeState();
    decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: true } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 500,
    });
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'low',
      confirmationPolicy: 'assume_applied',
    });
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    const whileOff = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: false } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 2_000,
    });

    expect(whileOff.reportedStepId).toBeUndefined();
    expect(runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.has('dev-1')).toBe(false);
    expect(runtimeState.steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);

    const afterTurnOn = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: true } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 3_000,
    });

    expect(afterTurnOn).toMatchObject({
      reportedStepId: undefined,
      desiredStepId: undefined,
      stepCommandPending: false,
      stepCommandStatus: 'idle',
    });
  });

  it('does not reinsert an ended-session command from a matching report on the off snapshot', () => {
    const runtimeState = createDeviceControlRuntimeState();
    decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: true } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 500,
    });
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      issuedAtMs: 1_000,
    });

    decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        binaryControl: { on: false },
        reportedStepId: 'max',
      }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 2_000,
    });

    expect(runtimeState.steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
  });

  it('ends the session when an off-step report contradicts a binary-on capability', () => {
    const runtimeState = createDeviceControlRuntimeState();
    decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: true } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 500,
    });
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'low',
      confirmationPolicy: 'assume_applied',
    });
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        binaryControl: { on: true },
        reportedStepId: 'off',
      }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 2_000,
    });

    expect(runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.has('dev-1')).toBe(false);
  });

  it('invalidates optimistic initialization when the configured lowest step changes', () => {
    const runtimeState = createDeviceControlRuntimeState();
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'low',
      confirmationPolicy: 'assume_applied',
    });
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });
    const changedProfiles: DeviceControlProfiles = {
      'dev-1': {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'minimum', planningPowerW: 800 },
          { id: 'low', planningPowerW: 1250 },
        ],
      },
    };

    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: true } }),
      profiles: changedProfiles,
      runtimeState,
      nowMs: 2_000,
    });

    expect(decorated.selectedStepId).toBe('minimum');
    expect(decorated.reportedStepId).toBeUndefined();
    expect(runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.has('dev-1')).toBe(false);
    expect(runtimeState.steppedLoadDesiredByDeviceId.has('dev-1')).toBe(false);
  });

  it('keeps a slow stepped-load step-up pending for 60s before confirmative telemetry arrives', () => {
    const runtimeState = createDeviceControlRuntimeState();

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
      pendingWindowMs: 180_000,
    });

    expect(pruneStaleSteppedLoadCommandStates(runtimeState, 61_000)).toBe(false);
    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'max',
      retryCount: 0,
      pending: true,
      status: 'pending',
      pendingWindowMs: 180_000,
    });

    expect(pruneStaleSteppedLoadCommandStates(runtimeState, 181_001)).toBe(true);
    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'max',
      retryCount: 0,
      nextRetryAtMs: 211_000,
      pending: false,
      status: 'stale',
      pendingWindowMs: 180_000,
    });
  });

  it('resolves default control models from explicit and implicit device shape', () => {
    expect(resolveDefaultControlModel(baseSnapshot({ controlModel: 'stepped_load' }))).toBe('stepped_load');
    expect(resolveDefaultControlModel(baseSnapshot({ deviceType: 'temperature', controlModel: undefined }))).toBe('temperature_target');
    expect(resolveDefaultControlModel(baseSnapshot({ deviceType: 'onoff', controlModel: undefined }))).toBe('binary_power');
  });

  it('builds a control-model map that DERIVES non-stepped models (raw controlModel is stepped-only)', () => {
    // Regression: the raw snapshot's `controlModel` is only `'stepped_load' | undefined`,
    // so the overview-signature map must derive temperature_target/binary_power from
    // `deviceType` (via resolveDefaultControlModel) — a bare `device.controlModel` read
    // leaves non-stepped devices out of the map and a temperature↔onoff flip never
    // reaches the signature.
    const map = buildControlModelMap([
      baseSnapshot({ id: 'temp', deviceType: 'temperature', controlModel: undefined }),
      baseSnapshot({ id: 'binary', deviceType: 'onoff', controlModel: undefined }),
      baseSnapshot({ id: 'stepped', controlModel: 'stepped_load' }),
    ]);
    expect(map.get('temp')).toBe('temperature_target');
    expect(map.get('binary')).toBe('binary_power');
    expect(map.get('stepped')).toBe('stepped_load');
  });

  it('resolves effective stepped-load profiles with native, stored, snapshot, then suggested precedence', () => {
    const snapshotProfile: SteppedLoadProfile = {
      model: 'stepped_load',
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'snapshot', planningPowerW: 1800 },
      ],
    };
    const suggestedProfile: SteppedLoadProfile = {
      model: 'stepped_load',
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'suggested', planningPowerW: 2200 },
      ],
    };

    expect(resolveEffectiveSteppedLoadProfile({
      snapshot: baseSnapshot({
        controlModel: 'stepped_load',
        steppedLoadProfile: snapshotProfile,
        suggestedSteppedLoadProfile: suggestedProfile,
      }),
      profiles: {},
      deviceId: 'dev-1',
    })).toBe(snapshotProfile);

    expect(resolveEffectiveSteppedLoadProfile({
      snapshot: baseSnapshot({
        controlModel: 'stepped_load',
        steppedLoadProfile: snapshotProfile,
      }),
      profiles: steppedProfiles,
      deviceId: 'dev-1',
    })).toBe(steppedProfiles['dev-1']);

    expect(resolveEffectiveSteppedLoadProfile({
      snapshot: baseSnapshot({
        controlModel: 'stepped_load',
        steppedLoadProfile: snapshotProfile,
        targetPowerConfig: { enabled: true, max: 3000, step: 1500 },
      }),
      profiles: steppedProfiles,
      deviceId: 'dev-1',
    })).toBe(snapshotProfile);

    expect(resolveEffectiveSteppedLoadProfile({
      snapshot: baseSnapshot({
        controlAdapter: {
          kind: 'capability_adapter',
          activationAvailable: true,
          activationEnabled: true,
          activationRequired: false,
        },
        suggestedSteppedLoadProfile: suggestedProfile,
      }),
      profiles: steppedProfiles,
      deviceId: 'dev-1',
    })).toBe(suggestedProfile);

    expect(resolveEffectiveSteppedLoadProfile({
      snapshot: baseSnapshot({ suggestedSteppedLoadProfile: suggestedProfile }),
      profiles: {},
      deviceId: 'dev-1',
    })).toBeNull();

    expect(resolveEffectiveSteppedLoadProfile({
      snapshot: baseSnapshot({
        controlModel: 'stepped_load',
        suggestedSteppedLoadProfile: suggestedProfile,
      }),
      profiles: {},
      deviceId: 'dev-1',
    })).toBe(suggestedProfile);
  });

  it('decorates non-stepped devices with their default control model only', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ id: 'plain-dev', deviceType: 'temperature' }),
      profiles: {},
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.controlModel).toBe('temperature_target');
    expect(decorated.desiredStepId).toBeUndefined();
    expect(decorated.selectedStepId).toBeUndefined();
  });

  it('uses the lowest active configured step as the default selected step for stepped loads', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: true } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.controlModel).toBe('stepped_load');
    expect(decorated.reportedStepId).toBeUndefined();
    expect(decorated.targetStepId).toBeUndefined();
    expect(decorated.selectedStepId).toBe('low');
    // No reported step → selectedStepId is the planning fallback (lowest active).
    expect(decorated.planningPowerKw).toBe(1.25);
    // expectedPowerKw is NOT overwritten — it retains the original snapshot
    // value, which the producer always resolves (no longer undefined).
    // Step-derived power stays available via planningPowerKw.
    expect(decorated.expectedPowerKw).toBe(1);
    expect(decorated.binaryControl?.on).toBe(true);
  });

  it('preserves existing expectedPowerKw and expectedPowerSource for stepped loads', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        binaryControl: { on: true },
        expectedPowerKw: 2.5,
        expectedPowerSource: 'measured-peak',
      }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.planningPowerKw).toBe(1.25);
    expect(decorated.expectedPowerKw).toBe(2.5);
    expect(decorated.expectedPowerSource).toBe('measured-peak');
  });

  it('preserves currentOn=false for stepped devices even with non-off step', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: false } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.controlModel).toBe('stepped_load');
    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.reportedStepId).toBeUndefined();
    expect(decorated.binaryControl?.on).toBe(false);
  });

  it('keeps native non-off step reports as observed truth even when currentOn=false', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        binaryControl: { on: false },
        reportedStepId: 'max',
        lastUpdated: 1_500,
        suggestedSteppedLoadProfile: steppedProfiles['dev-1'],
        controlAdapter: {
          kind: 'capability_adapter',
          activationAvailable: true,
          activationEnabled: true,
          activationRequired: false,
        },
      }),
      profiles: {},
      runtimeState,
      nowMs: 2_000,
    });

    expect(decorated.reportedStepId).toBe('max');
    expect(decorated.selectedStepId).toBe('max');
    expect(decorated.binaryControl?.on).toBe(false);
  });

  // Regression: prod 2026-07-25, Easee "Elbillader". The charger reverts its
  // dynamic current to 32 A at charging-session start and announces it over the
  // flow card, but that announcement lands while PELS's binary axis still reads
  // off (the on-echo trailed the write by 17-37 s on that device). Blanking the
  // report left the planner crediting a 6 A / 1.38 kW shed for a charger drawing
  // 7.36 kW, which produced a false hard-cap shortfall and a resume that breached
  // the cap. Flow reports are now admitted on the same terms as native ones.
  it('turns flow non-off feedback into reported truth while currentOn=false', () => {
    const runtimeState = createDeviceControlRuntimeState();

    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'max',
      reportedAtMs: 1_500,
    })).toBe('changed');

    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: false } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 2_000,
    });

    expect(decorated.reportedStepId).toBe('max');
    expect(decorated.selectedStepId).toBe('max');
    // The binary axis still owns the on/off fold: a non-off observed step must
    // not resurrect a device PELS has turned off.
    expect(decorated.binaryControl?.on).toBe(false);
    expect(resolveCurrentOn(decorated)).toBe(false);
  });

  it('uses parsed target-power step observations as reported stepped-load truth', () => {
    const runtimeState = createDeviceControlRuntimeState();
    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        binaryControl: { on: true },
        reportedStepId: 'max',
        lastUpdated: 1_500,
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfiles['dev-1'],
        targetPowerConfig: { enabled: true, preset: 'ev_charger_1_phase' },
      }),
      profiles: {},
      runtimeState,
      nowMs: 2_000,
    });

    expect(decorated.reportedStepId).toBe('max');
    expect(decorated.selectedStepId).toBe('max');
    expect(decorated.targetStepId).toBe('max');
    expect(decorated.stepCommandStatus).toBe('success');
  });

  it('uses target-power snapshot profiles for reported step decoration even when a stored profile exists', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const snapshotProfile: SteppedLoadProfile = {
      model: 'stepped_load',
      steps: [
        { id: '0w', planningPowerW: 0 },
        { id: '1500w', planningPowerW: 1500 },
        { id: '3000w', planningPowerW: 3000 },
      ],
    };

    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        binaryControl: { on: true },
        reportedStepId: '1500w',
        lastUpdated: 1_500,
        controlModel: 'stepped_load',
        steppedLoadProfile: snapshotProfile,
        targetPowerConfig: { enabled: true, max: 3000, step: 1500 },
      }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 2_000,
    });

    expect(decorated.steppedLoadProfile).toBe(snapshotProfile);
    expect(decorated.reportedStepId).toBe('1500w');
    expect(decorated.selectedStepId).toBe('1500w');
    expect(decorated.planningPowerKw).toBe(1.5);
  });

  it('preserves snapshot power source and currentOn when a stepped profile cannot resolve any step', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const emptyProfiles = {
      'dev-1': { model: 'stepped_load', steps: [] },
    } as unknown as DeviceControlProfiles;

    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ expectedPowerSource: 'manual', binaryControl: { on: false } }),
      profiles: emptyProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.selectedStepId).toBeUndefined();
    expect(decorated.planningPowerKw).toBeUndefined();
    expect(decorated.expectedPowerSource).toBe('manual');
    expect(decorated.binaryControl?.on).toBe(false);
  });

  it('does not infer a stepped level from measured power', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ measuredPowerKw: 1.2 }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.reportedStepId).toBeUndefined();
    expect(decorated.targetStepId).toBeUndefined();
    expect(decorated.planningPowerKw).toBe(1.25);
  });

  it('ignores persisted selected step when resolving stepped loads without confirmed feedback', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        binaryControl: { on: true },
        selectedStepId: 'max',
      }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.reportedStepId).toBeUndefined();
    expect(decorated.planningPowerKw).toBe(1.25);
  });

  it('tracks desired stepped commands, reports success, and can prune stale pending commands', () => {
    const runtimeState = createDeviceControlRuntimeState();

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'low',
      previousStepId: 'max',
      issuedAtMs: 1000,
    });

    const pendingDecorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot(),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1500,
    });
    expect(pendingDecorated.desiredStepId).toBe('low');
    expect(pendingDecorated.targetStepId).toBe('low');
    expect(pendingDecorated.reportedStepId).toBeUndefined();
    expect(pendingDecorated.selectedStepId).toBe('low');
    expect(pendingDecorated.stepCommandPending).toBe(true);
    expect(pendingDecorated.stepCommandStatus).toBe('pending');

    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'low',
      reportedAtMs: 1600,
    })).toBe('changed');
    expect(runtimeState.steppedLoadReportedByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'low',
    });

    const reportedDecorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: true } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1700,
    });
    expect(reportedDecorated.selectedStepId).toBe('low');
    expect(reportedDecorated.reportedStepId).toBe('low');
    expect(reportedDecorated.targetStepId).toBe('low');
    expect(reportedDecorated.stepCommandPending).toBe(false);
    expect(reportedDecorated.stepCommandStatus).toBe('success');

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'off',
      issuedAtMs: 2000,
    });
    expect(pruneStaleSteppedLoadCommandStates(runtimeState, 2000 + STEPPED_LOAD_COMMAND_STALE_MS + 1)).toBe(true);

    const staleDecorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ binaryControl: { on: true } }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 2000 + STEPPED_LOAD_COMMAND_STALE_MS + 1,
    });
    expect(staleDecorated.selectedStepId).toBe('low');
    expect(staleDecorated.reportedStepId).toBe('low');
    expect(staleDecorated.targetStepId).toBe('off');
    expect(staleDecorated.desiredStepId).toBe('off');
    expect(staleDecorated.stepCommandPending).toBe(false);
    expect(staleDecorated.stepCommandStatus).toBe('stale');
  });

  it('handles default timestamps, off-step reports, repeated reports, and invalid reported steps', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(4242);

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'off',
    });
    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      changedAtMs: 4242,
      lastIssuedAtMs: 4242,
      retryCount: 0,
      pending: true,
      status: 'pending',
    });

    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'off',
    })).toBe('changed');
    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'off',
    })).toBe('unchanged');

    const offDecorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot(),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 4300,
    });
    expect(offDecorated.selectedStepId).toBe('off');
    expect(offDecorated.reportedStepId).toBe('off');
    expect(offDecorated.binaryControl?.on).toBe(false);
    expect(offDecorated.planningPowerKw).toBe(0);

    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'missing',
      reportedAtMs: 1000,
    })).toBe('invalid');
    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'missing-device',
      stepId: 'low',
      reportedAtMs: 1000,
    })).toBe('invalid');
    nowSpy.mockRestore();
  });

  it('treats changed exact power as new feedback even when the reported step id is unchanged', () => {
    const runtimeState = createDeviceControlRuntimeState();

    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'low',
      planningPowerW: 1_200,
    })).toBe('changed');
    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'low',
      planningPowerW: 1_300,
    })).toBe('changed');
  });

  it('keeps a desired command pending when a different step is reported back', () => {
    const runtimeState = createDeviceControlRuntimeState();

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      issuedAtMs: 1000,
    });

    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'low',
      reportedAtMs: 1100,
    })).toBe('changed');

    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'max',
      retryCount: 0,
      pending: true,
      status: 'pending',
    });
  });

  it('preserves the latest plan target when flow feedback reports stepped-load drift', () => {
    const structuredLogger = { info: vi.fn() };
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: true } })],
      getLatestPlanSnapshot: () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      getStructuredLogger: () => structuredLogger as never,
      debugStructured: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    const runtimeState = helpers.getRuntimeStateForTests();
    expect(runtimeState.steppedLoadReportedByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'max',
    });
    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      previousStepId: 'max',
      retryCount: 0,
      pending: false,
      status: 'idle',
    });

    const [decorated] = helpers.decorateTargetSnapshotList([baseSnapshot({ binaryControl: { on: true } })]);
    expect(decorated.reportedStepId).toBe('max');
    expect(decorated.selectedStepId).toBe('max');
    expect(decorated.targetStepId).toBe('low');
    expect(decorated.desiredStepId).toBe('low');

    expect(structuredLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_feedback_mismatch',
      deviceId: 'dev-1',
      measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      reportedStepId: 'max',
      desiredStepId: 'low',
    }));
  });

  it('accepts flow feedback for snapshot-derived stepped-load profiles', () => {
    const structuredLogger = { info: vi.fn() };
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getDeviceSnapshots: () => [baseSnapshot({
        binaryControl: { on: true },
        steppedLoadProfile: steppedProfiles['dev-1'],
      })],
      getLatestPlanSnapshot: () => ({ devices: [] } as never),
      getStructuredLogger: () => structuredLogger as never,
      debugStructured: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'max',
    });
  });

  it('returns snapshot-defined stepped-load profiles when no stored profile exists', () => {
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getDeviceSnapshots: () => [baseSnapshot({
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfiles['dev-1'],
      })],
      getStructuredLogger: () => undefined,
      debugStructured: vi.fn(),
    });

    expect(helpers.getSteppedLoadProfile('dev-1')).toBe(steppedProfiles['dev-1']);
  });

  it('does not treat inactive native suggestions as effective stepped-load profiles', () => {
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getDeviceSnapshots: () => [baseSnapshot({
        controlAdapter: {
          kind: 'capability_adapter',
          activationAvailable: true,
          activationEnabled: false,
          activationRequired: false,
        },
        suggestedSteppedLoadProfile: steppedProfiles['dev-1'],
      })],
      getStructuredLogger: () => undefined,
      debugStructured: vi.fn(),
    });

    expect(helpers.getSteppedLoadProfile('dev-1')).toBeNull();
  });

  it('preserves latest plan targets for snapshot-only stepped-load feedback', () => {
    const structuredLogger = { info: vi.fn() };
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getDeviceSnapshots: () => [baseSnapshot({
        binaryControl: { on: true },
        controlModel: 'stepped_load',
        steppedLoadProfile: steppedProfiles['dev-1'],
      })],
      getLatestPlanSnapshot: () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      getStructuredLogger: () => structuredLogger as never,
      debugStructured: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      previousStepId: 'max',
      retryCount: 0,
      pending: false,
      status: 'idle',
    });
    expect(structuredLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_feedback_mismatch',
      deviceId: 'dev-1',
      reportedStepId: 'max',
      desiredStepId: 'low',
    }));
  });

  it('replaces a stale desired step with the latest plan target when feedback catches up', () => {
    const structuredLogger = { info: vi.fn() };
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: true } })],
      getLatestPlanSnapshot: () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      getStructuredLogger: () => structuredLogger as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');

    const runtimeState = helpers.getRuntimeStateForTests();
    expect(runtimeState.steppedLoadReportedByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'low',
    });
    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      previousStepId: 'low',
      retryCount: 0,
      pending: false,
      status: 'success',
    });

    const [decorated] = helpers.decorateTargetSnapshotList([baseSnapshot({ binaryControl: { on: true } })]);
    expect(decorated.reportedStepId).toBe('low');
    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.targetStepId).toBe('low');
    expect(decorated.desiredStepId).toBe('low');

    expect(structuredLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stepped_feedback_confirmed',
      deviceId: 'dev-1',
      measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      reportedStepId: 'low',
      desiredStepId: 'low',
    }));
  });

  it('replaces a stale desired step even when the repeated feedback report is unchanged', () => {
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: true } })],
      getLatestPlanSnapshot: () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('unchanged');

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      retryCount: 0,
      pending: false,
      status: 'success',
    });
  });

  // A non-off flow report matching the PENDING desired step while the device is
  // off is real telemetry: it lands on the OBSERVED axis and confirms the
  // commanded one through the ordinary report path (prod 2026-07-05 Elbillader
  // deadlock: dropping it wholesale left restore-from-off looping
  // waiting_confirmation -> stale -> retry_backoff forever).
  it('admits a matching non-off flow report while off as observed evidence and confirms the command', () => {
    const structuredLogger = { info: vi.fn() };
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: false } })],
      getStructuredLogger: () => structuredLogger as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    // Observed axis: real flow evidence, recorded even though the binary axis reads off.
    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
    });
    // Commanded axis: confirmed.
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'max',
      pending: false,
      status: 'success',
      retryCount: 0,
      nextRetryAtMs: undefined,
    });

    const [decorated] = helpers.decorateTargetSnapshotList([baseSnapshot({ binaryControl: { on: false } })]);
    expect(decorated.reportedStepId).toBe('max');
    expect(decorated.selectedStepId).toBe('max');
    // The binary axis still owns the on/off fold — a non-off observed step does
    // not resurrect a device PELS has turned off.
    expect(resolveCurrentOn(decorated)).toBe(false);
    expect(decorated.stepCommandStatus).toBe('success');
    expect(decorated.stepCommandPending).toBe(false);

    // The confirmation survives subsequent off-cycle decorations — only an on→off
    // TRANSITION expires it, not steady off state.
    const [redecorated] = helpers.decorateTargetSnapshotList([baseSnapshot({ binaryControl: { on: false } })]);
    expect(redecorated.stepCommandStatus).toBe('success');
  });

  it('expires a confirmed command on the observed on→off transition', () => {
    // A confirmation given while the device was ON (e.g. the shed-prep echo at
    // the lowest step) is evidence about a configuration that can drift
    // invisibly once the device is off. It must not fast-track a later
    // restore-from-off past its fresh prepare-and-confirm handshake.
    const snapshotHolder = { current: baseSnapshot({ binaryControl: { on: true } }) };
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [snapshotHolder.current],
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'low',
      previousStepId: 'max',
      issuedAtMs: 1_000,
    });
    // Report while ON is admitted normally and confirms the command.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    const [onDecorated] = helpers.decorateTargetSnapshotList([snapshotHolder.current]);
    expect(onDecorated.stepCommandStatus).toBe('success');

    // Device turns off: the stale confirmation is downgraded, so the next
    // restore-from-off must re-confirm through the flow.
    snapshotHolder.current = baseSnapshot({ binaryControl: { on: false } });
    const [offDecorated] = helpers.decorateTargetSnapshotList([snapshotHolder.current]);
    expect(offDecorated.stepCommandStatus).toBe('idle');
    expect(offDecorated.stepCommandPending).toBe(false);
  });

  it('confirms a preserved (never-commanded) desired step from a matching non-off report', () => {
    // Pinning intended behavior: an 'idle' entry created by plan-target
    // preservation can be confirmed by a matching non-off report while off —
    // the report attests the device's actual configured step, which is
    // stronger evidence than a command echo.
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: false } })],
      getLatestPlanSnapshot: () => ({
        devices: [{ id: 'dev-1', targetStepId: 'max', desiredStepId: 'max' }],
      } as never),
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    // An off-step report while off is admitted; plan-target preservation seeds
    // the tracked desired entry at status 'idle'.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'off')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      status: 'idle',
    });

    // The matching non-off report is admitted as observed evidence and confirms
    // the tracked step.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      status: 'success',
    });
  });

  it('lets a newer conflicting NON-OFF report invalidate a while-off confirmation', () => {
    // The device attests a different non-off step than the confirmed one — the
    // Easee case: the charger re-raised its dynamic current while paused. The
    // stale success must drop so the next restore re-handshakes at the real
    // configuration, and the conflicting step becomes the observed truth so the
    // planner stops modelling the commanded step it is no longer at.
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: false } })],
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'low',
      previousStepId: 'off',
      issuedAtMs: 1_000,
    });
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      status: 'success',
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'low',
      pending: false,
      status: 'idle',
    });
  });

  it('lets a newer conflicting admitted report invalidate a while-off confirmation', () => {
    // off → prepare-confirmed → the charger current is re-zeroed and the flow
    // reports the off step. The fresher telemetry contradicts the earlier
    // confirmation, which must lose so a stale 'success' cannot fast-track a
    // restore whose preparation was un-applied.
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: false } })],
      getLatestPlanSnapshot: () => ({
        devices: [{ id: 'dev-1', targetStepId: 'max', desiredStepId: 'max' }],
      } as never),
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      status: 'success',
    });

    // The off-step report while off is admitted and is newer than the confirmation.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'off')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      pending: false,
      status: 'idle',
    });
  });

  it('lets a matching non-off flow report confirm a STALE desired step (slow charger answered late)', () => {
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: false } })],
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
      pendingWindowMs: 5_000,
    });
    // Expire the pending window so the command goes stale before the report.
    pruneStaleSteppedLoadCommandStates(helpers.getRuntimeStateForTests(), 10_000);
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      status: 'stale',
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      pending: false,
      status: 'success',
      nextRetryAtMs: undefined,
    });
  });

  // Newly reachable once non-off reports are admitted while off: the report falls
  // through to plan-target preservation, which it could not do before. Pinned as
  // intended — when the plan has moved the target from 'max' to 'low', the in-flight
  // 'max' command IS obsolete, so dropping it and resetting the retry budget for the
  // new target is correct, not a lost command.
  it('lets a non-off report while off hand an in-flight command over to a newer plan target', () => {
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: false } })],
      getLatestPlanSnapshot: () => ({
        devices: [{ id: 'dev-1', targetStepId: 'low', desiredStepId: 'low' }],
      } as never),
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'off',
      issuedAtMs: 1_000,
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
      status: 'pending',
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'low',
      pending: false,
      status: 'idle',
      retryCount: 0,
    });
    // The report still lands on the observed axis regardless of the handover.
    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'max',
    });
  });

  it('does not let a NON-matching non-off flow report confirm the pending desired step', () => {
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: false } })],
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    // 'low' is non-off and contradicts the commanded 'max': admitted as observed
    // truth, but it confirms nothing — the command stays pending.
    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');

    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId.get('dev-1')).toMatchObject({
      stepId: 'low',
    });
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'max',
      pending: true,
      status: 'pending',
      retryCount: 0,
    });
  });

  it('returns invalid for unknown flow step reports even when currentOn=false', () => {
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ binaryControl: { on: false } })],
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      debugStructured: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'missing')).toBe('invalid');
    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId.get('dev-1')).toBeUndefined();
  });

  it('increments stepped-load retry metadata when the same desired step is re-issued', () => {
    const runtimeState = createDeviceControlRuntimeState();

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
      pendingWindowMs: 90_000,
    });

    expect(pruneStaleSteppedLoadCommandStates(runtimeState, 91_001)).toBe(true);
    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      retryCount: 0,
      nextRetryAtMs: 121_000,
      pending: false,
      status: 'stale',
    });

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 122_000,
      pendingWindowMs: 90_000,
    });

    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      retryCount: 1,
      nextRetryAtMs: undefined,
      pending: true,
      status: 'pending',
    });
  });

  it('resets retry escalation after a same-step command has already been confirmed', () => {
    const runtimeState = createDeviceControlRuntimeState();

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
      pendingWindowMs: 90_000,
    });
    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'max',
      reportedAtMs: 2_000,
    })).toBe('changed');

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 3_000,
      pendingWindowMs: 90_000,
    });

    expect(runtimeState.steppedLoadDesiredByDeviceId.get('dev-1')).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      retryCount: 0,
      nextRetryAtMs: undefined,
      pending: true,
      status: 'pending',
    });
  });

  it('normalizes stored stepped-load profile maps', () => {
    expect(normalizeStoredDeviceControlProfiles({
      'dev-1': steppedProfiles['dev-1'],
      'dev-2': { model: 'stepped_load', steps: [{ id: '', planningPowerW: 0 }] },
    })).toEqual({
      'dev-1': steppedProfiles['dev-1'],
    });

    expect(normalizeStoredDeviceControlProfiles(null)).toBeNull();
  });
});
