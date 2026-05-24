import {
  AppDeviceControlHelpers,
  STEPPED_LOAD_COMMAND_STALE_MS,
  createDeviceControlRuntimeState,
  decorateSnapshotWithDeviceControl,
  markSteppedLoadDesiredStepIssued,
  normalizeStoredDeviceControlProfiles,
  pruneStaleSteppedLoadCommandStates,
  resolveEffectiveSteppedLoadProfile,
  reportSteppedLoadActualStep,
  resolveDefaultControlModel,
} from '../lib/app/appDeviceControlHelpers';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { DeviceControlProfiles, TargetDeviceSnapshot } from '../packages/contracts/src/types';

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

const baseSnapshot = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'dev-1',
  name: 'Water heater',
  targets: [],
  deviceType: 'onoff',
  currentOn: false,
  measuredPowerKw: 0,
  ...overrides,
});

describe('appDeviceControlHelpers', () => {
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
    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'max',
      retryCount: 0,
      pending: true,
      status: 'pending',
      pendingWindowMs: 180_000,
    });

    expect(pruneStaleSteppedLoadCommandStates(runtimeState, 181_001)).toBe(true);
    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
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

  it('resolves effective stepped-load profiles with native, stored, snapshot, then suggested precedence', () => {
    const snapshotProfile = {
      model: 'stepped_load',
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'snapshot', planningPowerW: 1800 },
      ],
    } as const;
    const suggestedProfile = {
      model: 'stepped_load',
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'suggested', planningPowerW: 2200 },
      ],
    } as const;

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
      snapshot: baseSnapshot({ currentOn: true }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.controlModel).toBe('stepped_load');
    expect(decorated.reportedStepId).toBeUndefined();
    expect(decorated.targetStepId).toBeUndefined();
    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.actualStepId).toBeUndefined();
    expect(decorated.assumedStepId).toBe('low');
    expect(decorated.actualStepSource).toBe('assumed');
    expect(decorated.planningPowerKw).toBe(1.25);
    // expectedPowerKw is NOT overwritten — it retains the original snapshot value
    // (undefined here). Step-derived power is available via planningPowerKw.
    expect(decorated.expectedPowerKw).toBeUndefined();
    expect(decorated.currentOn).toBe(true);
  });

  it('preserves existing expectedPowerKw and expectedPowerSource for stepped loads', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        currentOn: true,
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
      snapshot: baseSnapshot({ currentOn: false }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.controlModel).toBe('stepped_load');
    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.assumedStepId).toBe('low');
    expect(decorated.actualStepSource).toBe('assumed');
    expect(decorated.currentOn).toBe(false);
  });

  it('keeps native non-off step reports as observed truth even when currentOn=false', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        currentOn: false,
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
    expect(decorated.actualStepId).toBe('max');
    expect(decorated.assumedStepId).toBeUndefined();
    expect(decorated.actualStepSource).toBe('reported');
    expect(decorated.currentOn).toBe(false);
  });

  it('does not turn flow non-off feedback into reported truth while currentOn=false', () => {
    const runtimeState = createDeviceControlRuntimeState();

    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'max',
      reportedAtMs: 1_500,
    })).toBe('changed');

    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ currentOn: false }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 2_000,
    });

    expect(decorated.reportedStepId).toBeUndefined();
    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.actualStepId).toBeUndefined();
    expect(decorated.assumedStepId).toBe('low');
    expect(decorated.actualStepSource).toBe('assumed');
    expect(decorated.currentOn).toBe(false);
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
        currentOn: true,
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
    expect(decorated.actualStepId).toBe('max');
    expect(decorated.actualStepSource).toBe('reported');
    expect(decorated.targetStepId).toBe('max');
    expect(decorated.stepCommandStatus).toBe('success');
  });

  it('uses target-power snapshot profiles for reported step decoration even when a stored profile exists', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const snapshotProfile = {
      model: 'stepped_load',
      steps: [
        { id: '0w', planningPowerW: 0 },
        { id: '1500w', planningPowerW: 1500 },
        { id: '3000w', planningPowerW: 3000 },
      ],
    } as const;

    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        currentOn: true,
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
    expect(decorated.actualStepId).toBe('1500w');
    expect(decorated.actualStepSource).toBe('reported');
    expect(decorated.planningPowerKw).toBe(1.5);
  });

  it('preserves snapshot power source and currentOn when a stepped profile cannot resolve any step', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const emptyProfiles = {
      'dev-1': { model: 'stepped_load', steps: [] },
    } as unknown as DeviceControlProfiles;

    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ expectedPowerSource: 'manual', currentOn: false }),
      profiles: emptyProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.selectedStepId).toBeUndefined();
    expect(decorated.planningPowerKw).toBeUndefined();
    expect(decorated.expectedPowerSource).toBe('manual');
    expect(decorated.currentOn).toBe(false);
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
    expect(decorated.actualStepId).toBeUndefined();
    expect(decorated.assumedStepId).toBe('low');
    expect(decorated.actualStepSource).toBe('assumed');
    expect(decorated.planningPowerKw).toBe(1.25);
  });

  it('ignores persisted selected step when resolving stepped loads without confirmed feedback', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({
        currentOn: true,
        selectedStepId: 'max',
      }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.reportedStepId).toBeUndefined();
    expect(decorated.actualStepId).toBeUndefined();
    expect(decorated.assumedStepId).toBe('low');
    expect(decorated.actualStepSource).toBe('assumed');
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
    expect(pendingDecorated.assumedStepId).toBe('low');
    expect(pendingDecorated.actualStepSource).toBe('assumed');
    expect(pendingDecorated.stepCommandPending).toBe(true);
    expect(pendingDecorated.stepCommandStatus).toBe('pending');

    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'low',
      reportedAtMs: 1600,
    })).toBe('changed');
    expect(runtimeState.steppedLoadReportedByDeviceId['dev-1']).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'low',
    });

    const reportedDecorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ currentOn: true }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1700,
    });
    expect(reportedDecorated.selectedStepId).toBe('low');
    expect(reportedDecorated.reportedStepId).toBe('low');
    expect(reportedDecorated.targetStepId).toBe('low');
    expect(reportedDecorated.actualStepId).toBe('low');
    expect(reportedDecorated.assumedStepId).toBeUndefined();
    expect(reportedDecorated.actualStepSource).toBe('reported');
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
      snapshot: baseSnapshot({ currentOn: true }),
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
    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
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
    expect(offDecorated.actualStepId).toBe('off');
    expect(offDecorated.actualStepSource).toBe('reported');
    expect(offDecorated.currentOn).toBe(false);
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

    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
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
      getDeviceSnapshots: () => [baseSnapshot({ currentOn: true })],
      getLatestPlanSnapshot: () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      getStructuredLogger: () => structuredLogger as never,
      logDebug: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    const runtimeState = helpers.getRuntimeStateForTests();
    expect(runtimeState.steppedLoadReportedByDeviceId['dev-1']).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'max',
    });
    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      previousStepId: 'max',
      retryCount: 0,
      pending: false,
      status: 'idle',
    });

    const [decorated] = helpers.decorateTargetSnapshotList([baseSnapshot({ currentOn: true })]);
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
        currentOn: true,
        steppedLoadProfile: steppedProfiles['dev-1'],
      })],
      getLatestPlanSnapshot: () => ({ devices: [] } as never),
      getStructuredLogger: () => structuredLogger as never,
      logDebug: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');
    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId['dev-1']).toMatchObject({
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
      logDebug: vi.fn(),
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
      logDebug: vi.fn(),
    });

    expect(helpers.getSteppedLoadProfile('dev-1')).toBeNull();
  });

  it('preserves latest plan targets for snapshot-only stepped-load feedback', () => {
    const structuredLogger = { info: vi.fn() };
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => ({}),
      getDeviceSnapshots: () => [baseSnapshot({
        currentOn: true,
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
      logDebug: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('changed');

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
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
      getDeviceSnapshots: () => [baseSnapshot({ currentOn: true })],
      getLatestPlanSnapshot: () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      getStructuredLogger: () => structuredLogger as never,
      logDebug: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');

    const runtimeState = helpers.getRuntimeStateForTests();
    expect(runtimeState.steppedLoadReportedByDeviceId['dev-1']).toMatchObject({
      capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
      source: 'flow',
      stepId: 'low',
    });
    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      previousStepId: 'low',
      retryCount: 0,
      pending: false,
      status: 'success',
    });

    const [decorated] = helpers.decorateTargetSnapshotList([baseSnapshot({ currentOn: true })]);
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
      getDeviceSnapshots: () => [baseSnapshot({ currentOn: true })],
      getLatestPlanSnapshot: () => ({
        devices: [{
          id: 'dev-1',
          targetStepId: 'low',
          desiredStepId: 'low',
        }],
      } as never),
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      logDebug: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('changed');
    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'low')).toBe('unchanged');

    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
      capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      stepId: 'low',
      retryCount: 0,
      pending: false,
      status: 'success',
    });
  });

  it('does not let suppressed flow feedback confirm a pending desired step while currentOn=false', () => {
    const helpers = new AppDeviceControlHelpers({
      getProfiles: () => steppedProfiles,
      getDeviceSnapshots: () => [baseSnapshot({ currentOn: false })],
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      logDebug: vi.fn(),
    });

    helpers.markSteppedLoadDesiredStepIssued({
      deviceId: 'dev-1',
      desiredStepId: 'max',
      previousStepId: 'low',
      issuedAtMs: 1_000,
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'max')).toBe('unchanged');

    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId['dev-1']).toBeUndefined();
    expect(helpers.getRuntimeStateForTests().steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
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
      getDeviceSnapshots: () => [baseSnapshot({ currentOn: false })],
      getStructuredLogger: () => ({ info: vi.fn() }) as never,
      logDebug: vi.fn(),
    });

    expect(helpers.reportSteppedLoadActualStep('dev-1', 'missing')).toBe('invalid');
    expect(helpers.getRuntimeStateForTests().steppedLoadReportedByDeviceId['dev-1']).toBeUndefined();
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
    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
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

    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
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

    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
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
