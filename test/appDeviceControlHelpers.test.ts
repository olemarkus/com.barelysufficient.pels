import {
  STEPPED_LOAD_COMMAND_STALE_MS,
  createDeviceControlRuntimeState,
  decorateSnapshotWithDeviceControl,
  markSteppedLoadDesiredStepIssued,
  normalizeStoredDeviceControlProfiles,
  pruneStaleSteppedLoadCommandStates,
  reportSteppedLoadActualStep,
  resolveDefaultControlModel,
} from '../lib/app/appDeviceControlHelpers';
import type { DeviceControlProfiles, TargetDeviceSnapshot } from '../lib/utils/types';

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
  it('resolves default control models from explicit and implicit device shape', () => {
    expect(resolveDefaultControlModel(baseSnapshot({ controlModel: 'stepped_load' }))).toBe('stepped_load');
    expect(resolveDefaultControlModel(baseSnapshot({ deviceType: 'temperature', controlModel: undefined }))).toBe('temperature_target');
    expect(resolveDefaultControlModel(baseSnapshot({ deviceType: 'onoff', controlModel: undefined }))).toBe('binary_power');
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

  it('uses the highest configured step as the default selected step for stepped loads', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ currentOn: true }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.controlModel).toBe('stepped_load');
    expect(decorated.selectedStepId).toBe('max');
    expect(decorated.actualStepId).toBeUndefined();
    expect(decorated.assumedStepId).toBe('max');
    expect(decorated.actualStepSource).toBeUndefined();
    expect(decorated.planningPowerKw).toBe(3);
    expect(decorated.expectedPowerKw).toBe(3);
    expect(decorated.expectedPowerSource).toBe('step-planning');
    expect(decorated.currentOn).toBe(true);
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
    expect(decorated.selectedStepId).toBe('max');
    expect(decorated.currentOn).toBe(false);
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

  it('uses a power heuristic when measured power matches a configured stepped level', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const decorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot({ measuredPowerKw: 1.2 }),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1000,
    });

    expect(decorated.selectedStepId).toBe('low');
    expect(decorated.actualStepId).toBe('low');
    expect(decorated.assumedStepId).toBe('low');
    expect(decorated.actualStepSource).toBe('power_heuristic');
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
    expect(pendingDecorated.selectedStepId).toBe('max');
    expect(pendingDecorated.assumedStepId).toBe('max');
    expect(pendingDecorated.stepCommandPending).toBe(true);
    expect(pendingDecorated.stepCommandStatus).toBe('pending');

    expect(reportSteppedLoadActualStep({
      runtimeState,
      profiles: steppedProfiles,
      deviceId: 'dev-1',
      stepId: 'low',
      reportedAtMs: 1600,
    })).toBe('changed');

    const reportedDecorated = decorateSnapshotWithDeviceControl({
      snapshot: baseSnapshot(),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 1700,
    });
    expect(reportedDecorated.selectedStepId).toBe('low');
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
      snapshot: baseSnapshot(),
      profiles: steppedProfiles,
      runtimeState,
      nowMs: 2000 + STEPPED_LOAD_COMMAND_STALE_MS + 1,
    });
    expect(staleDecorated.selectedStepId).toBe('low');
    expect(staleDecorated.desiredStepId).toBe('off');
    expect(staleDecorated.stepCommandPending).toBe(false);
    expect(staleDecorated.stepCommandStatus).toBe('stale');
  });

  it('handles default timestamps, off-step reports, repeated reports, and invalid reported steps', () => {
    const runtimeState = createDeviceControlRuntimeState();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(4242);

    markSteppedLoadDesiredStepIssued({
      runtimeState,
      deviceId: 'dev-1',
      desiredStepId: 'off',
    });
    expect(runtimeState.steppedLoadDesiredByDeviceId['dev-1']).toMatchObject({
      changedAtMs: 4242,
      lastIssuedAtMs: 4242,
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
    expect(offDecorated.actualStepId).toBe('off');
    expect(offDecorated.currentOn).toBe(false);
    expect(offDecorated.planningPowerKw).toBe(0);
    expect(offDecorated.expectedPowerSource).toBe('step-planning');

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
      stepId: 'max',
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
