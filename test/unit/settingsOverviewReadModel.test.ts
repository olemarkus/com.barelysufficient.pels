import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import {
  buildSettingsOverviewDeviceReadModel,
  buildSettingsOverviewReadModel,
} from '../../lib/plan/settingsOverviewReadModel';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';

describe('settingsOverviewReadModel', () => {
  it('projects capacity and effective hour budgets for settings overview', () => {
    const device = buildPlanDevice({
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    });

    const readModel = buildSettingsOverviewReadModel({
      meta: {
        totalKw: 0.6,
        softLimitKw: 4.54,
        dailySoftLimitKw: 4.54,
        budgetPaceKw: 1.46,
        projectedExemptKw: 3.08,
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
      dailySoftLimitKw: 4.5,
      budgetPaceKw: 1.4,
      projectedExemptKw: 3.1,
      budgetKWh: 9.5,
      capacityHourBudgetKWh: 9.5,
      capacityLimitKw: 5,
      dailyBudgetHourKWh: 12,
      hourBudgetKWh: 9.5,
    });
    expect(
      (readModel?.meta?.budgetPaceKw ?? 0) + (readModel?.meta?.projectedExemptKw ?? 0),
    ).toBe(readModel?.meta?.dailySoftLimitKw);
  });

  it('excludes auto-tracked observe-only role devices (battery / solar) from the overview devices', () => {
    const keepReason = { code: PLAN_REASON_CODES.keep, detail: null } as const;
    const heater = buildPlanDevice({ id: 'heater', deviceClass: 'heater', reason: keepReason });
    const battery = buildPlanDevice({ id: 'home-battery', deviceClass: 'battery', reason: keepReason });
    const solar = buildPlanDevice({ id: 'solar', deviceClass: 'solarpanel', reason: keepReason });

    const readModel = buildSettingsOverviewReadModel({
      meta: {
        totalKw: 0.6,
        softLimitKw: 4.5,
        headroomKw: 3.9,
        usedKWh: 0.02,
        budgetKWh: 9.5,
        capacityLimitKw: 5,
        dailyBudgetHourKWh: 12,
      },
      devices: [heater, battery, solar],
    });

    const ids = (readModel?.devices ?? []).map((d) => d.id);
    expect(ids).toContain('heater');
    expect(ids).not.toContain('home-battery');
    expect(ids).not.toContain('solar');
    expect(readModel?.devices).toHaveLength(1);
  });

  it('uses daily budget allocation as the effective hour budget when tighter', () => {
    const device = buildPlanDevice({
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
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
      profile: isSteppedLoadDevice(device) ? device.steppedLoadProfile : undefined,
      reportedStepId: 'low',
      targetStepId: 'max',
      commandPending: true,
    });
  });

  it('uses the producer-confirmed profile instead of a planner-only probe rung', () => {
    const device = steppedPlanDevice({
      reportedStepId: 'medium',
      targetStepId: 'max',
      stepCommandPending: true,
    });
    expect(isSteppedLoadDevice(device)).toBe(true);
    if (!isSteppedLoadDevice(device)) throw new Error('expected stepped test device');
    const confirmedProfile = {
      steps: device.steppedLoadProfile.steps.filter((step) => step.id !== 'max'),
    };

    expect(buildSettingsOverviewDeviceReadModel(
      device,
      {},
      undefined,
      confirmedProfile,
    ).steppedLoad).toEqual(expect.objectContaining({
      profile: confirmedProfile,
      targetStepId: confirmedProfile.steps.at(-1)?.id,
      commandPending: false,
    }));
  });

  it('treats stepped-load step commands as pending overview commands', () => {
    const device = steppedPlanDevice({
      reportedStepId: 'low',
      targetStepId: 'max',
      stepCommandPending: true,
      binaryCommandPending: false,
      pendingTargetCommand: undefined,
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
      binaryCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
    });

    // The observer is the canonical owner; the read model must surface ITS value.
    expect(buildSettingsOverviewDeviceReadModel(device, {
      getObservedEvChargingState: (id) => (id === 'ev-1' ? 'plugged_in_charging' : undefined),
    }).evChargingState).toBe('plugged_in_charging');

    // With no observer dep wired, the plan device must not leak a raw plug-state.
    expect(buildSettingsOverviewDeviceReadModel(device).evChargingState).toBeUndefined();
  });

  it('surfaces the EV battery reading so the card can show it beside the level', () => {
    const device = buildPlanDevice({
      id: 'ev-1',
      binaryCapabilityId: 'evcharger_charging',
      stateOfCharge: stateOfChargeFixture({ percent: 64, observedAtMs: 1_000, sessionStartedAtMs: 500 }),
    });

    // Projected to what the wire type declares: the observation layer's session
    // bookkeeping is its own business (`notes/ev-soc-layering.md`).
    expect(buildSettingsOverviewDeviceReadModel(device).stateOfCharge)
      .toEqual({ level: { kind: 'known', percent: 64 } });
  });

  it('emits no battery reading for a device that has none', () => {
    const device = buildPlanDevice({ id: 'heater-1' });
    expect(buildSettingsOverviewDeviceReadModel(device).stateOfCharge).toBeUndefined();
  });

  it('emits the producer deviceType and the stepped cluster the card selects on', () => {
    // The card used to be picked from a reconstructed `controlModel`. It is now
    // picked from these two: `steppedLoad` presence for the stepped card, and
    // `deviceType` for the temperature card — including a temperature device
    // with NO `plannedTarget` (skip / abandon-grace), which is exactly the case
    // `plannedTarget` alone cannot carry.
    const temp = buildPlanDevice({ id: 'temp-1' }); // non-stepped, no plannedTarget
    const tempRead = buildSettingsOverviewDeviceReadModel(temp, {}, 'temperature');
    expect(tempRead.deviceType).toBe('temperature');
    expect(tempRead.steppedLoad).toBeUndefined();

    const binary = buildPlanDevice({ id: 'bin-1' });
    const binaryRead = buildSettingsOverviewDeviceReadModel(binary, {}, 'onoff');
    expect(binaryRead.deviceType).toBe('onoff');
    expect(binaryRead.steppedLoad).toBeUndefined();
    // No producer deviceType at all: still no stepped cluster, so the generic
    // card. Absence is the marker for "neither stepped nor temperature".
    expect(buildSettingsOverviewDeviceReadModel(binary, {}).steppedLoad).toBeUndefined();

    // Stepped wins regardless of producer deviceType (a stepped thermostat stays stepped).
    const stepped = steppedPlanDevice({ id: 'step-1' });
    expect(buildSettingsOverviewDeviceReadModel(stepped, {}, 'temperature').steppedLoad).toBeDefined();
  });

  it('keeps a stored-profile stepped device stepped', () => {
    // The read model used to reconstruct a `controlModel` setting and consult
    // the producer map FIRST, which made its stepped rung unreachable: that map
    // is built from the RAW snapshot, whose control model is only ever set for
    // NATIVE stepped devices, so a device whose ladder comes from
    // `deviceControlProfiles` arrived marked `binary_power` and was demoted.
    //
    // Not a label-only concern: `PlanOverview` picks the card COMPONENT off
    // stepped-ness, and `formatDeviceOverview` uses it to choose the 'Planned'
    // vs 'Expected' label, append the step text, and suppress `powerMsg`. The
    // device rendered as a generic card while the overview log seam recorded the
    // same device as stepped. The device's own ladder is now the discriminant,
    // so there is no producer setting left to disagree with it.
    const stepped = steppedPlanDevice({ id: 'stored-profile-step' });
    expect(buildSettingsOverviewDeviceReadModel(stepped, {}, 'onoff').steppedLoad).toBeDefined();
    expect(buildSettingsOverviewDeviceReadModel(stepped, {}, 'temperature').steppedLoad).toBeDefined();
  });

  it('threads the producer deviceType map through the top-level read model', () => {
    const temp = buildPlanDevice({ id: 'temp-2' });
    const readModel = buildSettingsOverviewReadModel(
      { generatedAtMs: 0, meta: {}, devices: [temp] } as never,
      { getDeviceTypeById: () => new Map([['temp-2', 'temperature']]) },
    );
    expect(readModel?.devices?.[0]?.deviceType).toBe('temperature');
  });

  it('keeps observed temperature presentation when effective control is binary', () => {
    const device = buildPlanDevice({
      id: 'externally-controlled-thermostat',
      deviceType: 'onoff',
      binaryCapabilityId: 'onoff',
      shedAction: 'turn_off',
    });
    const readModel = buildSettingsOverviewReadModel(
      { generatedAtMs: 0, meta: {}, devices: [device] } as never,
      {
        getDeviceTypeById: () => new Map([['externally-controlled-thermostat', 'temperature']]),
        getObservedTemperature: () => ({ currentTarget: 22, currentTemperature: 20.3 }),
      },
    );

    expect(readModel?.devices?.[0]).toMatchObject({
      deviceType: 'temperature',
      // The facet is complete even for a binary-commanded temperature device:
      // "no commanded setpoint" materializes as planned === current, never as
      // a partial facet.
      temperature: { currentTarget: 22, currentTemperature: 20.3, plannedTarget: 22 },
      shedAction: 'turn_off',
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
  it('does not label a drawing target-only device as idle', () => {
    // `isSatisfiedTargetOnlyDevice` (shared-domain) decides "idle" partly on
    // `currentDrawKw <= 0.05`. The shared shape used to name that field
    // `measuredPowerKw` and make it optional, so a carrier that did not adapt
    // compiled clean, read `undefined`, and labelled every at-target thermostat
    // idle even while it was drawing. Both halves are fixed at the type — same
    // producer-resolved name, required — and this pins the behaviour.
    // `currentState: 'not_applicable'` is what makes a device target-ONLY: no
    // on/off handle, so its state word cannot be read from a binary axis.
    const drawing = buildPlanDevice({
      id: 'thermo',
      deviceType: 'temperature',
      binaryCapabilityId: undefined,
      currentState: 'not_applicable',
      currentTarget: 21,
      currentTemperature: 22,
      currentDrawKw: 1.4,
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    });
    expect(buildSettingsOverviewDeviceReadModel(drawing).stateKind).not.toBe('idle');

    const settled = buildPlanDevice({
      id: 'thermo',
      deviceType: 'temperature',
      binaryCapabilityId: undefined,
      currentState: 'not_applicable',
      currentTarget: 21,
      currentTemperature: 22,
      currentDrawKw: 0,
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    });
    expect(buildSettingsOverviewDeviceReadModel(settled).stateKind).toBe('idle');
  });
});
