import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import {
  buildSettingsOverviewDeviceReadModel,
  buildSettingsOverviewReadModel,
} from '../../lib/plan/settingsOverviewReadModel';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, buildPlanMeta, steppedPlanDevice } from '../utils/planTestUtils';

const absentTemperature = {
  getObservedTemperature: () => ({ kind: 'absent' } as const),
};

const observedTemperature = (currentTarget: number, currentTemperature: number) => ({
  getObservedTemperature: () => ({
    kind: 'observed' as const,
    value: { currentTarget, currentTemperature },
  }),
});

describe('settingsOverviewReadModel', () => {
  it('projects capacity and effective hour budgets for settings overview', () => {
    const device = buildPlanDevice({
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    });

    const readModel = buildSettingsOverviewReadModel({
      meta: buildPlanMeta({
        totalKw: 0.6,
        softLimitKw: 4.54,
        dailySoftLimitKw: 4.54,
        budgetPaceKw: 1.46,
        projectedExemptKw: 3.08,
        headroomKw: 3.94,
        usedKWh: 0.02,
        budgetKWh: 9.5,
        capacityLimitKw: 5,
        dailyBudgetHourKWh: 12}),
      devices: [device],
    }, absentTemperature);

    // Only what the wire still carries. The inputs above are planner-meta
    // fields; most of them stopped crossing to the settings UI once the wire
    // shape dropped everything no consumer read.
    expect(readModel?.meta).toMatchObject({
      softLimitKw: 4.5,
      budgetPaceKw: 1.4,
      projectedExemptKw: 3.1,
      // The subject of this test: the effective hour budget is the tighter of
      // the capacity budget (9.5) and the daily allocation (12). Its two inputs
      // stay local to the read model and are deliberately not on the wire.
      hourBudgetKWh: 9.5,
    });
  });

  it('does not ship meta fields nothing renders', () => {
    // Pins the wire shape itself. The read model used to `...spread` the whole
    // planner meta, so half the payload was fields no consumer read — and
    // deleting one from the DTO did not stop it being emitted, because a spread
    // bypasses excess-property checking. The producer lists fields explicitly
    // now; this is the runtime half of that guarantee.
    const readModel = buildSettingsOverviewReadModel({
      meta: buildPlanMeta({
        totalKw: 0.6,
        softLimitKw: 4.54,
        dailySoftLimitKw: 4.54,
        headroomKw: 3.94,
        usedKWh: 0.02,
        budgetKWh: 9.5,
        capacityLimitKw: 5,
        dailyBudgetHourKWh: 12,
        hasLivePowerSample: true,
        capacityShortfall: false,
        dailyBudgetExceeded: false}),
      devices: [buildPlanDevice({ reason: { code: PLAN_REASON_CODES.keep, detail: null } })],
    } as never, absentTemperature);

    for (const dead of [
      'dailySoftLimitKw', 'powerNowKw', 'hasLivePowerSample', 'powerSampleAgeMs',
      'capacityShortfall', 'shortfallBudgetThresholdKw', 'shortfallBudgetHeadroomKw',
      'hardCapHeadroomKw', 'hourlyBudgetExhausted', 'budgetKWh', 'capacityHourBudgetKWh',
      'capacityLimitKw', 'dailyBudgetRemainingKWh', 'dailyBudgetExceeded', 'dailyBudgetHourKWh',
    ]) {
      expect(readModel?.meta).not.toHaveProperty(dead);
    }
  });

  it('excludes auto-tracked observe-only role devices (battery / solar) from the overview devices', () => {
    const keepReason = { code: PLAN_REASON_CODES.keep, detail: null } as const;
    const heater = buildPlanDevice({ id: 'heater', deviceClass: 'heater', reason: keepReason });
    const battery = buildPlanDevice({ id: 'home-battery', deviceClass: 'battery', reason: keepReason });
    const solar = buildPlanDevice({ id: 'solar', deviceClass: 'solarpanel', reason: keepReason });

    const readModel = buildSettingsOverviewReadModel({
      meta: buildPlanMeta({
        totalKw: 0.6,
        softLimitKw: 4.5,
        headroomKw: 3.9,
        usedKWh: 0.02,
        budgetKWh: 9.5,
        capacityLimitKw: 5,
        dailyBudgetHourKWh: 12}),
      devices: [heater, battery, solar],
    }, absentTemperature);

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
      meta: buildPlanMeta({
        totalKw: 0.6,
        softLimitKw: 4.54,
        headroomKw: 3.94,
        usedKWh: 0.02,
        budgetKWh: 9.5,
        capacityLimitKw: 5,
        dailyBudgetHourKWh: 4.25}),
      devices: [device],
    }, absentTemperature);

    // The daily allocation (4.25) is tighter than the capacity budget (9.5), so
    // it wins. Both inputs stay local to the read model — only the resolved
    // effective budget crosses to the settings UI.
    expect(readModel?.meta?.hourBudgetKWh).toBe(4.25);
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

    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).steppedLoad).toEqual({
      profile: isSteppedLoadDevice(device) ? device.steppedLoadProfile : undefined,
      reportedStepId: 'low',
      targetStepId: 'max',
      // Both now ride the cluster rather than travelling as flat copies beside
      // it. The fixture's ladder prices `low` at 1 kW.
      selectedStepId: 'low',
      planningPowerKw: isSteppedLoadDevice(device) ? device.planningPowerKw : undefined,
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
      absentTemperature,
      confirmedProfile,
    ).steppedLoad).toEqual(expect.objectContaining({
      profile: confirmedProfile,
      targetStepId: confirmedProfile.steps.at(-1)?.id,
      commandPending: false,
    }));
  });

  it('carries ONE target step id, so the card and the label cannot disagree', () => {
    // Regression pin for a live divergence. `buildOverviewSteppedLoad` corrects
    // the target when the planner aims at a rung the CONFIRMED ladder lacks
    // (`plannerOnlyTarget`) — it shows where the device actually is, because a
    // pending move to a rung the owner cannot see would never appear to land.
    //
    // The read model used to emit that corrected id on the `steppedLoad`
    // cluster AND the raw planner id as a flat `targetStepId` beside it. The
    // stepped card reads the cluster; `getSteppedModeTransitionText` reads the
    // flat pair. On a trimmed ladder the two answered differently, so the card
    // showed no transition while the overview label rendered "medium → max"
    // for a step that is not on the ladder.
    //
    // One field now, on the cluster. This test fails if a flat copy comes back.
    const device = steppedPlanDevice({
      reportedStepId: 'medium',
      targetStepId: 'max',
      stepCommandPending: true,
    });
    if (!isSteppedLoadDevice(device)) throw new Error('expected stepped test device');
    const confirmedProfile = {
      steps: device.steppedLoadProfile.steps.filter((step) => step.id !== 'max'),
    };
    const corrected = confirmedProfile.steps.at(-1)?.id;

    const readModel = buildSettingsOverviewDeviceReadModel(device, absentTemperature, confirmedProfile);

    expect(readModel.steppedLoad?.targetStepId).toBe(corrected);
    expect(readModel.steppedLoad?.targetStepId).not.toBe('max');
    // No second, uncorrected source for the same fact.
    expect(readModel).not.toHaveProperty('targetStepId');
    expect(readModel).not.toHaveProperty('desiredStepId');
    expect(readModel).not.toHaveProperty('reportedStepId');
  });

  it('treats stepped-load step commands as pending overview commands', () => {
    const device = steppedPlanDevice({
      reportedStepId: 'low',
      targetStepId: 'max',
      stepCommandPending: true,
      binaryCommandPending: false,
      pendingTargetCommand: undefined,
    });

    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).steppedLoad).toMatchObject({
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

    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).steppedLoad).toMatchObject({
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
      ...absentTemperature,
      getObservedEvChargingState: (id) => (id === 'ev-1' ? 'plugged_in_charging' : undefined),
    }).evChargingState).toBe('plugged_in_charging');

    // With no observer dep wired, the plan device must not leak a raw plug-state.
    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).evChargingState).toBeUndefined();
  });

  it('surfaces the EV battery reading so the card can show it beside the level', () => {
    const device = buildPlanDevice({ id: 'ev-1', binaryCapabilityId: 'evcharger_charging' });

    // Sourced from the OBSERVER, which owns the reading — the plan device carries
    // the boost decision, never the level it was made from. Projected to what the
    // wire type declares: the observation layer's session bookkeeping is its own
    // business (`notes/ev-soc-layering.md`).
    expect(buildSettingsOverviewDeviceReadModel(device, {
      ...absentTemperature,
      getObservedStateOfCharge: () => stateOfChargeFixture({
        percent: 64, observedAtMs: 1_000, sessionStartedAtMs: 500,
      }),
    }).stateOfCharge).toEqual({ level: { kind: 'known', percent: 64 } });

    // With no observer dep wired there is no reading to show.
    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).stateOfCharge).toBeUndefined();
  });

  it('emits no battery reading for a device that has none', () => {
    const device = buildPlanDevice({ id: 'heater-1' });
    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).stateOfCharge).toBeUndefined();
  });

  it('emits the two clusters the card selects on, and nothing else to select on', () => {
    // The card used to be picked from a reconstructed `controlModel`, then from
    // a producer `deviceType` label. Both are gone: the discriminants are now
    // the two clusters that actually carry what the card renders — `steppedLoad`
    // presence for the stepped card, `temperature` presence for the temperature
    // card. A device carrying neither gets the generic card.
    const binary = buildPlanDevice({ id: 'bin-1' });
    const binaryRead = buildSettingsOverviewDeviceReadModel(binary, absentTemperature);
    expect(binaryRead.steppedLoad).toBeUndefined();
    expect(binaryRead.temperature).toBeUndefined();

    // Stepped-ness comes from the device's own ladder, not from any label.
    const stepped = steppedPlanDevice({ id: 'step-1' });
    expect(buildSettingsOverviewDeviceReadModel(stepped, absentTemperature).steppedLoad).toBeDefined();
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
    expect(buildSettingsOverviewDeviceReadModel(stepped, absentTemperature).steppedLoad).toBeDefined();
  });

  it('keeps observed temperature presentation when effective control is binary', () => {
    const device = buildPlanDevice({
      id: 'externally-controlled-thermostat',
      deviceType: 'onoff',
      binaryCapabilityId: 'onoff',
      shedAction: 'turn_off',
    });
    const readModel = buildSettingsOverviewReadModel(
      { generatedAtMs: 0, meta: buildPlanMeta({}), devices: [device] } as never,
      observedTemperature(22, 20.3),
    );

    expect(readModel?.devices?.[0]).toMatchObject({
      // The facet is complete even for a binary-commanded temperature device:
      // "no commanded setpoint" materializes as planned === current, never as
      // a partial facet. Its presence is also what gives this device the
      // temperature card — the observed pair is the whole reason the owner
      // still sees a temperature for a thermostat PELS only switches on and off.
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

    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).reason).toEqual({
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
    expect(buildSettingsOverviewDeviceReadModel(drawing, observedTemperature(21, 22)).stateKind).not.toBe('idle');

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
    expect(buildSettingsOverviewDeviceReadModel(settled, observedTemperature(21, 22)).stateKind).toBe('idle');
  });
  describe('boost on the wire', () => {
    // One bit, carried through as the planner decided it. The read model used to
    // ship two per-axis flags and re-derive WHICH axis was boosting by
    // presence-sniffing the observer and the config seams — a discrimination the
    // planner does not make and the snapshot has no way to make correctly. The
    // card's hover wording is the view's job now (`PlanDeviceCards.tsx`).
    const boosting = (overrides: Parameters<typeof buildPlanDevice>[0] = {}) => buildPlanDevice({
      id: 'dev',
      boostActive: true,
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
      ...overrides,
    });

    it('carries the boost decision through for a charger', () => {
      const deps = {
        ...absentTemperature,
        getObservedEvChargingState: () => 'plugged_in_charging' as const,
      };
      expect(buildSettingsOverviewDeviceReadModel(boosting(), deps).boostActive).toBe(true);
    });

    it('carries the same bit for a temperature device, with no second answer beside it', () => {
      const device = buildSettingsOverviewDeviceReadModel(
        boosting({ deviceType: 'temperature' }),
        absentTemperature,
      );
      expect(device.boostActive).toBe(true);
      // The retired pair must not come back: a snapshot carrying a per-axis flag
      // is a snapshot answering a question the plan never asked.
      expect('evBoostActive' in device).toBe(false);
      expect('temperatureBoostActive' in device).toBe(false);
    });

    it('does not courier the configured boost thresholds onto the wire', () => {
      const device = buildSettingsOverviewDeviceReadModel(boosting(), absentTemperature);
      // The THRESHOLDS are settings. The settings UI reads them from the settings
      // store it already owns (`state.{temperature,ev}BoostSettings`), so a copy
      // on the plan wire is a second source for one fact and nothing ever read
      // it. Only the DECISION (`boostActive`, asserted above) belongs here.
      expect('temperatureBoost' in device).toBe(false);
      expect('evBoost' in device).toBe(false);
    });

    it('reports not boosting when the device is not boosting', () => {
      const device = buildSettingsOverviewDeviceReadModel(buildPlanDevice({
        id: 'dev',
        reason: { code: PLAN_REASON_CODES.keep, detail: null },
      }), absentTemperature);
      expect(device.boostActive).toBe(false);
    });
  });
});
