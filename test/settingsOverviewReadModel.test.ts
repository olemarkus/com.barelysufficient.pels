import { buildSettingsOverviewDeviceReadModel } from '../lib/plan/settingsOverviewReadModel';
import { PLAN_REASON_CODES } from '../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, steppedPlanDevice } from './utils/planTestUtils';

describe('settingsOverviewReadModel', () => {
  it('projects stepped-load overview state from reported evidence and target intent', () => {
    const device = steppedPlanDevice({
      id: 'step-1',
      reportedStepId: 'low',
      targetStepId: 'max',
      desiredStepId: 'max',
      selectedStepId: 'low',
      pendingTargetCommand: {
        desired: 1,
        retryCount: 0,
        nextRetryAtMs: 123,
        status: 'waiting_confirmation',
      },
    });

    expect(buildSettingsOverviewDeviceReadModel(device).steppedLoad).toEqual({
      profile: device.steppedLoadProfile,
      reportedStepId: 'low',
      targetStepId: 'max',
      commandPending: true,
    });
  });

  it('treats stepped-load step commands as pending overview commands', () => {
    const device = steppedPlanDevice({
      reportedStepId: 'low',
      targetStepId: 'max',
      stepCommandPending: true,
      binaryCommandPending: false,
      pendingTargetCommand: null,
    });

    expect(buildSettingsOverviewDeviceReadModel(device).steppedLoad).toMatchObject({
      commandPending: true,
    });
  });

  it('does not expose assumed or selected steps as observed stepped-load UI truth', () => {
    const device = steppedPlanDevice({
      reportedStepId: undefined,
      actualStepId: 'medium',
      actualStepSource: 'assumed',
      assumedStepId: 'medium',
      selectedStepId: 'medium',
      targetStepId: 'max',
      desiredStepId: 'max',
    });

    expect(buildSettingsOverviewDeviceReadModel(device).steppedLoad).toMatchObject({
      reportedStepId: null,
      targetStepId: 'max',
    });
  });

  it('keeps planner cooldown reasons available as structured read-model data', () => {
    const device = buildPlanDevice({
      reason: {
        code: PLAN_REASON_CODES.cooldownRestore,
        remainingSec: 42,
        countdownStartedAtMs: 10,
      },
    });

    expect(buildSettingsOverviewDeviceReadModel(device).reason).toEqual({
      code: PLAN_REASON_CODES.cooldownRestore,
      remainingSec: 42,
      countdownStartedAtMs: 10,
    });
  });
});
