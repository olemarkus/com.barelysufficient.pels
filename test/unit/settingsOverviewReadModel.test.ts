import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import {
  buildSettingsOverviewDeviceReadModel as buildDevice,
  buildSettingsOverviewReadModel as buildPlan,
} from '../../lib/plan/settingsOverviewReadModel';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, buildPlanMeta, steppedPlanDevice } from '../utils/planTestUtils';
import { executionStateFixture } from '../utils/deviceStatusFixture';
import type { SettingsOverviewReadModelDeps } from '../../lib/plan/settingsOverviewReadModel';


const buildSettingsOverviewDeviceReadModel = (
  device: Parameters<typeof buildDevice>[0],
  deps: Omit<SettingsOverviewReadModelDeps, 'getDeviceExecutionState' | 'dryRun' | 'nowMs'>,
  profile?: Parameters<typeof buildDevice>[3],
) => buildDevice(device, { ...deps, getDeviceExecutionState: () => executionStateFixture(device),
  dryRun: false, nowMs: 0 }, 0, profile);
const buildSettingsOverviewReadModel = (
  plan: Parameters<typeof buildPlan>[0],
  deps: Omit<SettingsOverviewReadModelDeps, 'getDeviceExecutionState' | 'dryRun' | 'nowMs'>,
) => buildPlan(plan, { ...deps, getDeviceExecutionState: (id) => {
  const device = plan?.devices.find((candidate) => candidate.id === id);
  if (!device) throw new Error('missing fixture device');
  return executionStateFixture(device);
}, dryRun: false, nowMs: plan?.generatedAtMs ?? 0 });

// Both observer reads are REQUIRED deps, so every double states both. A test that
// cares about only one still has to say the other is absent — which is the point:
// an un-wired accessor stopped being a third way of saying "no reading".
const absentStateOfCharge = {
  getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
  getObservedEvChargingState: () => ({ kind: 'absent' } as const),
};

const absentTemperature = {
  ...absentStateOfCharge,
  getObservedTemperature: () => ({ kind: 'absent' } as const),
};

const observedTemperature = (currentTarget: number, currentTemperature: number) => ({
  ...absentStateOfCharge,
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

  it('exposes resolved presentation without control axes, targets or plan reasons', () => {
    const device = steppedPlanDevice({ reportedStepId: 'low', desiredStepId: 'max', stepCommandPending: true });
    const wire = buildSettingsOverviewDeviceReadModel(device, absentTemperature);
    expect(wire.status.cardKind).toBe('stepped');
    expect(wire.status.rail?.activeIndex).toBe(1);
    for (const key of ['currentState', 'plannedState', 'reason', 'stateKind', 'stateTone',
      'binaryCommandPending', 'pendingTargetCommand', 'steppedLoad', 'temperature',
      'reportedStepId', 'selectedStepId', 'desiredStepId', 'targetStepId', 'steppedLoadProfile',
      'shedAction', 'shedTemperature', 'evChargingState', 'carChargingState', 'idleClassification', 'execution']) {
      expect(wire).not.toHaveProperty(key);
    }
  });

  it('does not expose a selected fallback as observed rail position', () => {
    const device = steppedPlanDevice({ reportedStepId: undefined, selectedStepId: 'medium', desiredStepId: 'max' });
    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).status.rail?.activeIndex).toBeNull();
  });

  it('uses executor-owned step-only restoration and pending movement in presentation', () => {
    const device = steppedPlanDevice({ binaryCapabilityId: undefined, currentState: 'off',
      reportedStepId: 'off', selectedStepId: 'off', desiredStepId: 'low', plannedState: 'keep' });
    const wire = buildDevice(device, {
      ...absentTemperature, dryRun: false, nowMs: 0,
      getDeviceExecutionState: () => ({ ...executionStateFixture(device), desiredBinary: null,
        resumeExpected: true, steppedTransitionPending: true }),
    }, 0);
    expect(wire.status).toMatchObject({ kind: 'resuming', label: 'Resuming',
      reason: { text: 'Turning on to Low' } });
  });

  it('shows binary restore movement even when a stepped device already reports its desired step', () => {
    const device = steppedPlanDevice({ currentState: 'off', reportedStepId: 'low',
      selectedStepId: 'low', desiredStepId: 'low', plannedState: 'keep' });
    const wire = buildDevice(device, {
      ...absentTemperature, dryRun: false, nowMs: 0,
      getDeviceExecutionState: () => ({ ...executionStateFixture(device), binaryProgress: 'pending',
        stepProgress: 'settled', resumeExpected: true, steppedTransitionPending: true }),
    }, 0);
    expect(wire.status).toMatchObject({ kind: 'resuming', reason: { text: 'Turning on to Low' } });
  });

  it.each(['unavailable', 'manual'] as const)('suppresses stale idle guidance when %s', (kind) => {
    const device = buildPlanDevice({ available: kind !== 'unavailable', controllable: kind !== 'manual' });
    const wire = buildSettingsOverviewDeviceReadModel(device, {
      ...absentTemperature,
      getIdleClassification: () => 'unresponsive',
    });
    expect(wire.status.kind).toBe(kind);
    expect(wire.status.reason).toBeNull();
  });

  it('calls a charger a charger before it has reported any plug-state', () => {
    const device = buildPlanDevice({
      id: 'ev-1',
      deviceRole: 'ev_charger',
      binaryCapabilityId: 'evcharger_charging',
    });

    const read = buildSettingsOverviewDeviceReadModel(device, absentTemperature);
    expect(read.deviceRole).toBe('ev_charger');
    // …and still reports no plug-state, which is the honest half of the answer.
    expect(read).not.toHaveProperty('evChargingState');
  });

  it('does not call a non-charger a charger just because it reported something', () => {
    const device = buildPlanDevice({ id: 'heater-1' });
    expect(buildSettingsOverviewDeviceReadModel(device, {
      ...absentTemperature,
      getObservedEvChargingState: () => ({ kind: 'observed', value: 'plugged_in' } as const),
    }).deviceRole).toBeUndefined();
  });

  it('surfaces the EV battery reading so the card can show it beside the level', () => {
    const device = buildPlanDevice({ id: 'ev-1', binaryCapabilityId: 'evcharger_charging' });

    // Sourced from the OBSERVER, which owns the reading — the plan device carries
    // the boost decision, never the level it was made from. The observer has
    // already projected away its own session bookkeeping, so the read model
    // re-shapes nothing (`notes/ev-soc-layering.md`). The level still comes from
    // the producer's fixture so this cannot drift from a shape it can emit.
    expect(buildSettingsOverviewDeviceReadModel(device, {
      ...absentTemperature,
      getObservedStateOfCharge: () => ({
        kind: 'observed' as const,
        value: {
          level: stateOfChargeFixture({
            percent: 64, observedAtMs: 1_000, sessionStartedAtMs: 500,
          }).level,
        },
      }),
    }).stateOfCharge).toEqual({ level: { kind: 'known', percent: 64, observedAtMs: 1_000 } });

    // An ABSENT read shows nothing. Distinct from a present read whose `level`
    // says there is none: that one is a statement about a charger that does
    // report, and it reaches the card as `stateOfCharge` with an unavailable
    // level rather than as no reading at all.
    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).stateOfCharge).toBeUndefined();
  });

  it('emits no battery reading for a device that has none', () => {
    const device = buildPlanDevice({ id: 'heater-1' });
    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).stateOfCharge).toBeUndefined();
  });

  it('includes the observer battery percentage in the complete stepped charger fact', () => {
    const device = steppedPlanDevice({ id: 'ev-1', deviceRole: 'ev_charger',
      binaryCapabilityId: 'evcharger_charging', currentState: 'on', reportedStepId: 'low' });
    const getObservedStateOfCharge = vi.fn(() => ({ kind: 'observed' as const,
      value: { level: stateOfChargeFixture({ percent: 64, observedAtMs: 1_000 }).level } }));
    const wire = buildSettingsOverviewDeviceReadModel(device, {
      ...absentTemperature, getObservedStateOfCharge,
      getObservedEvChargingState: () => ({ kind: 'observed', value: 'plugged_in_charging' } as const),
    });
    expect(wire.status.factText).toBe('Charging · 64 % · level Low');
    expect(getObservedStateOfCharge).toHaveBeenCalledTimes(1);
    expect(buildSettingsOverviewDeviceReadModel(device, absentTemperature).status.factText).toBe('Level Low');
  });

  it('resolves card kind in the backend', () => {
    // The UI selects the supplied card kind without receiving raw device facets.
    const binary = buildPlanDevice({ id: 'bin-1' });
    const binaryRead = buildSettingsOverviewDeviceReadModel(binary, absentTemperature);
    expect(binaryRead.status.cardKind).toBe('binary');
    expect(binaryRead.status.factText).toBeNull();

    // Stepped-ness comes from the device's own ladder, not from any label.
    const stepped = steppedPlanDevice({ id: 'step-1' });
    expect(buildSettingsOverviewDeviceReadModel(stepped, absentTemperature).status.cardKind).toBe('stepped');
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
    expect(buildSettingsOverviewDeviceReadModel(stepped, absentTemperature).status.cardKind).toBe('stepped');
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
      status: { cardKind: 'temperature', factText: '20.3 °C · target 22 °C' },
    });
  });

  it('publishes a stable countdown without the planner reason', () => {
    const device = buildPlanDevice({ reason: { code: PLAN_REASON_CODES.cooldownRestore,
      remainingSec: 42, countdownStartedAtMs: 10 } });
    const wire = buildSettingsOverviewDeviceReadModel(device, absentTemperature);
    expect(wire.status.reason?.countdown?.endsAtMs).toBe(42_010);
    expect(wire).not.toHaveProperty('reason');
  });

  it('anchors a countdown to the decision when refreshing presentation later', () => {
    const device = buildPlanDevice({ reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 42 } });
    const wire = buildPlan({ generatedAtMs: 1_000, meta: buildPlanMeta({}), devices: [device] }, {
      ...absentTemperature, dryRun: false, nowMs: 11_000,
      getDeviceExecutionState: () => executionStateFixture(device),
    });
    expect(wire?.devices?.[0].status.reason?.countdown?.endsAtMs).toBe(43_000);
    expect(wire?.devices?.[0].status.reason?.text).toContain('32s');
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
    expect(buildSettingsOverviewDeviceReadModel(drawing, observedTemperature(21, 22)).status.kind).not.toBe('idle');

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
    expect(buildSettingsOverviewDeviceReadModel(settled, observedTemperature(21, 22)).status.kind).toBe('idle');
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
        getObservedEvChargingState: () => ({ kind: 'observed', value: 'plugged_in_charging' } as const),
      };
      expect(buildSettingsOverviewDeviceReadModel(boosting(), deps).boostActive).toBe(true);
    });

    it('carries the same bit for a temperature device, with no second answer beside it', () => {
      const device = buildSettingsOverviewDeviceReadModel(
        boosting({ deviceType: 'temperature', currentTarget: 21, currentTemperature: 20 }),
        absentTemperature,
      );
      expect(device.boostActive).toBe(true);
      // The retired pair must not come back: a snapshot carrying a per-axis flag
      // is a snapshot answering a question the plan never asked.
      expect('evBoostActive' in device).toBe(false);
      expect('temperatureBoostActive' in device).toBe(false);
    });

    it('does not courier the device\'s identity or ordering onto the wire', () => {
      const device = buildSettingsOverviewDeviceReadModel(boosting(), absentTemperature);
      // `priority` and `zone` are settings/registry facts about the DEVICE. The
      // Overview reads them from the device list it already renders from — the
      // list owns membership and order — so a copy here is a second source for
      // one fact, and since that surface moved, nothing read this one.
      expect('priority' in device).toBe(false);
      expect('zone' in device).toBe(false);
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
