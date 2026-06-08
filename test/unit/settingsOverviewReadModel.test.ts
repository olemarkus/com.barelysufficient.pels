import {
  buildSettingsOverviewDeviceReadModel,
  buildSettingsOverviewReadModel,
} from '../../lib/plan/settingsOverviewReadModel';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';

describe('settingsOverviewReadModel', () => {
  it('projects capacity and effective hour budgets for settings overview', () => {
    const device = buildPlanDevice({
      reason: { code: PLAN_REASON_CODES.none },
    });

    const readModel = buildSettingsOverviewReadModel({
      meta: {
        totalKw: 0.6,
        softLimitKw: 4.54,
        headroomKw: 3.94,
        usedKWh: 0.02,
        budgetKWh: 9.5,
        capacityLimitKw: 5,
        dailyBudgetHourKWh: 12,
      },
      devices: [device],
    });

    expect(readModel?.meta).toMatchObject({
      softLimitKw: 4.5,
      budgetKWh: 9.5,
      capacityHourBudgetKWh: 9.5,
      capacityLimitKw: 5,
      dailyBudgetHourKWh: 12,
      hourBudgetKWh: 9.5,
    });
  });

  it('uses daily budget allocation as the effective hour budget when tighter', () => {
    const device = buildPlanDevice({
      reason: { code: PLAN_REASON_CODES.none },
    });

    const readModel = buildSettingsOverviewReadModel({
      meta: {
        totalKw: 0.6,
        softLimitKw: 4.54,
        headroomKw: 3.94,
        usedKWh: 0.02,
        budgetKWh: 9.5,
        capacityLimitKw: 5,
        dailyBudgetHourKWh: 4.25,
      },
      devices: [device],
    });

    expect(readModel?.meta).toMatchObject({
      capacityHourBudgetKWh: 9.5,
      dailyBudgetHourKWh: 4.25,
      hourBudgetKWh: 4.25,
    });
  });

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
      // Fallback-only effective step must not surface as observed UI truth.
      selectedStepId: 'medium',
      targetStepId: 'max',
      desiredStepId: 'max',
    });

    expect(buildSettingsOverviewDeviceReadModel(device).steppedLoad).toMatchObject({
      reportedStepId: null,
      targetStepId: 'max',
    });
  });

  it('sources evChargingState from the observer dep, not the plan device', () => {
    // The plan device carries the producer-resolved flat EV plug-state sub-fields, not
    // the raw plug-state (materialized + stripped by the test builder, mirroring toPlanDevice).
    const device = buildPlanDevice({
      id: 'ev-1',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
    });

    // The observer is the canonical owner; the read model must surface ITS value.
    expect(buildSettingsOverviewDeviceReadModel(device, {
      getObservedEvChargingState: (id) => (id === 'ev-1' ? 'plugged_in_charging' : undefined),
    }).evChargingState).toBe('plugged_in_charging');

    // With no observer dep wired, the plan device must not leak a raw plug-state.
    expect(buildSettingsOverviewDeviceReadModel(device).evChargingState).toBeUndefined();
  });

  it('reproduces the control-mode card from profile-presence + producer deviceType', () => {
    // controlModel is a producer setting the planner no longer carries. The read
    // model must still emit the faithful value so the settings-UI picks the right
    // card — including a temperature device with NO plannedTarget (skip /
    // abandon-grace), which previously relied on controlModel === 'temperature_target'.
    const temp = buildPlanDevice({ id: 'temp-1' }); // non-stepped, no plannedTarget
    expect(buildSettingsOverviewDeviceReadModel(temp, {}, 'temperature').controlModel)
      .toBe('temperature_target');

    const binary = buildPlanDevice({ id: 'bin-1' });
    expect(buildSettingsOverviewDeviceReadModel(binary, {}, 'onoff').controlModel).toBe('binary_power');
    // Absent deviceType (not in the producer map) falls back to binary, matching resolveDefaultControlModel.
    expect(buildSettingsOverviewDeviceReadModel(binary, {}).controlModel).toBe('binary_power');

    const stepped = steppedPlanDevice({ id: 'step-1' });
    // Stepped wins regardless of producer deviceType (a stepped thermostat stays stepped).
    expect(buildSettingsOverviewDeviceReadModel(stepped, {}, 'temperature').controlModel).toBe('stepped_load');
  });

  it('threads the producer deviceType map through the top-level read model', () => {
    const temp = buildPlanDevice({ id: 'temp-2' });
    const readModel = buildSettingsOverviewReadModel(
      { generatedAtMs: 0, meta: {}, devices: [temp] } as never,
      { getDeviceTypeById: () => new Map([['temp-2', 'temperature']]) },
    );
    expect(readModel?.devices?.[0]?.controlModel).toBe('temperature_target');
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
