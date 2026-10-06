import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import {
  buildSettingsOverviewDeviceReadModel as buildDevice,
  buildSettingsOverviewReadModel as buildPlan,
} from '../../lib/plan/settingsOverviewReadModel';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, buildPlanMeta, steppedPlanDevice } from '../utils/planTestUtils';
import { executionStateFixture } from '../utils/deviceStatusFixture';
import type { SettingsOverviewReadModelDeps } from '../../lib/plan/settingsOverviewReadModel';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { formatStepDisplayLabel } from '../../packages/shared-domain/src/steppedStepLabel';


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
  getHomeBatteryCard: () => ({ kind: 'none' } as const),
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
    const heater = buildPlanDevice({ id: 'heater', reason: keepReason });
    const battery = buildPlanDevice({ id: 'home-battery', isBatteryOrSolar: true, reason: keepReason });
    const solar = buildPlanDevice({ id: 'solar', isBatteryOrSolar: true, reason: keepReason });

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

  it.each([
    { code: PLAN_REASON_CODES.capacity, dryRun: false },
    { code: PLAN_REASON_CODES.dailyBudget, dryRun: false },
    { code: PLAN_REASON_CODES.capacity, dryRun: true },
    { code: PLAN_REASON_CODES.dailyBudget, dryRun: true },
  ])('explains a settled $code step hold in simulation=$dryRun', ({ code, dryRun }) => {
    const device = steppedPlanDevice({
      plannedState: 'shed', currentState: 'on', currentDrawKw: 1.25,
      reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'low',
      reason: { code, shortfallKw: 0.9 },
    });
    const wire = buildDevice(device, {
      ...absentTemperature, dryRun, nowMs: 0,
      getDeviceExecutionState: () => executionStateFixture(device),
    }, 0);

    expect(wire.status.kind).toBe(dryRun ? 'active' : 'held');
    expect(wire.status.reason?.text).toBe(dryRun
      ? 'Would be waiting to increase — 0.9 kW more needed (simulation)'
      : 'Waiting to increase — 0.9 kW more needed');
  });

  it('keeps a settled stepped hold ahead of the car waiting explanation', () => {
    const device = steppedPlanDevice({
      isEvCharger: true, plannedState: 'shed', currentState: 'on',
      reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'low',
      reason: { code: PLAN_REASON_CODES.capacity },
    });
    const wire = buildSettingsOverviewDeviceReadModel(device, {
      ...absentTemperature,
      getObservedEvChargingState: () => ({ kind: 'observed', value: 'plugged_in' }),
    });

    expect(wire.status.reason?.text).toBe('Waiting to resume');
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

  it('does not present a pending EV probe rung outside the confirmed ladder as turning off', () => {
    // A probe asks for the rung above the confirmed ladder; the card is given the
    // confirmed ladder, so the probe target is not one of its steps. Show where
    // the charger is, not a turn-off it never received.
    const device = steppedPlanDevice({ isEvCharger: true, currentState: 'on', plannedState: 'keep',
      reportedStepId: 'medium', selectedStepId: 'max', desiredStepId: 'max', stepCommandPending: true });
    const confirmed = { steps: device.steppedLoadProfile.steps.filter((step) => step.id !== 'max') };
    const wire = buildDevice(device, {
      ...absentTemperature, dryRun: false, nowMs: 0,
      getDeviceExecutionState: () => executionStateFixture(device),
    }, 0, confirmed);

    expect(wire.status.kind).toBe('active');
    expect(wire.status.reason).toBeNull();
    expect(wire.status.rail).toEqual({
      labels: confirmed.steps.map((step) => formatStepDisplayLabel(step.id)),
      activeIndex: confirmed.steps.findIndex((step) => step.id === 'medium'),
    });
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
      isEvCharger: true,
      binaryCapabilityId: 'evcharger_charging',
    });

    const read = buildSettingsOverviewDeviceReadModel(device, absentTemperature);
    expect(read.isEvCharger).toBe(true);
    // …and still reports no plug-state, which is the honest half of the answer.
    expect(read).not.toHaveProperty('evChargingState');
  });

  it('does not call a non-charger a charger just because it reported something', () => {
    const device = buildPlanDevice({ id: 'heater-1' });
    expect(buildSettingsOverviewDeviceReadModel(device, {
      ...absentTemperature,
      getObservedEvChargingState: () => ({ kind: 'observed', value: 'plugged_in' } as const),
    }).isEvCharger).toBe(false);
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
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
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
    const device = steppedPlanDevice({ id: 'ev-1', isEvCharger: true,
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

  it.each([
    ['a charger with power-limit control off', { controllable: false }, 'Unplugged · Level Low', null],
    // The held charger's state word names its level ("Limited · Low"), so its
    // fact line keeps only the exception.
    ['a charger PELS holds at a lower level', { plannedState: 'shed' as const,
      reason: { code: PLAN_REASON_CODES.capacity } }, 'Unplugged', 'Waiting to resume'],
  ])('keeps the charger exception in the fact line for %s', (_case, overrides, factText, reasonText) => {
    const device = steppedPlanDevice({ id: 'ev-1', isEvCharger: true, currentState: 'on',
      reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'low', ...overrides });
    const wire = buildSettingsOverviewDeviceReadModel(device, {
      ...absentTemperature,
      getObservedEvChargingState: () => ({ kind: 'observed', value: 'plugged_out' } as const),
    });
    expect(wire.status.factText).toBe(factText);
    expect(wire.status.reason?.text ?? null).toBe(reasonText);
  });

  it('keeps the cooldown ring when the reported-load line replaces the timed reason', () => {
    const device = buildPlanDevice({ id: 'heater', currentState: 'on', plannedState: 'shed', currentDrawKw: 1.2,
      reason: { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30, countdownStartedAtMs: 0,
        countdownTotalSec: 60 } });
    const wire = buildSettingsOverviewDeviceReadModel(device, absentTemperature);
    expect(wire.status.reason?.text).not.toMatch(/\d+s/);
    expect(wire.status.reason?.countdown).toEqual({ kind: 'beside_text', endsAtMs: 60_000, totalSec: 60 });
  });

  it('reads an off device the plan would resume, held by a hold reason, as limited', () => {
    const device = buildPlanDevice({ id: 'heater', currentState: 'off', plannedState: 'keep',
      reason: { code: PLAN_REASON_CODES.restoreThrottled } });
    const wire = buildDevice(device, {
      ...absentTemperature, dryRun: false, nowMs: 0,
      getDeviceExecutionState: () => ({ ...executionStateFixture(device), resumeExpected: true }),
    }, 0);
    expect(wire.status).toMatchObject({ kind: 'held', label: 'Limited · Off' });
    // With the command in flight it is resuming, whatever the reason.
    const inFlight = buildDevice(device, {
      ...absentTemperature, dryRun: false, nowMs: 0,
      getDeviceExecutionState: () => ({ ...executionStateFixture(device), resumeExpected: true,
        binaryProgress: 'pending' }),
    }, 0);
    expect(inFlight.status).toMatchObject({ kind: 'resuming', label: 'Resuming' });
  });

  it('names a held stepped charger\'s level once, in its state word', () => {
    const device = steppedPlanDevice({ id: 'ev-1', isEvCharger: true, currentState: 'on',
      plannedState: 'shed', reportedStepId: 'low', selectedStepId: 'low', desiredStepId: 'low',
      reason: { code: PLAN_REASON_CODES.capacity } });
    const wire = buildSettingsOverviewDeviceReadModel(device, {
      ...absentTemperature,
      getObservedEvChargingState: () => ({ kind: 'observed', value: 'plugged_out' } as const),
    });
    expect(wire.status.label).toBe('Limited · Low');
    expect(wire.status.factText).toBe('Unplugged');
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
    // Not a label-only concern: the card COMPONENT and the activity log both
    // follow the resolved card kind. The device once rendered as a generic card
    // while the overview log seam recorded it as stepped. The device's own
    // ladder is now the discriminant, so there is no producer setting left to
    // disagree with it.
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

describe('settingsOverviewReadModel home battery card', () => {
  const battery = (overrides: { signedW?: number | null; percent?: number; drivable?: boolean } = {}) => ({
    ...absentTemperature,
    getHomeBatteryCard: (deviceId: string) => (deviceId === 'battery-1'
      ? {
        kind: 'battery' as const,
        drivable: overrides.drivable ?? true,
        power: overrides.signedW === null
          ? { kind: 'absent' as const }
          : { kind: 'observed' as const, signedW: overrides.signedW ?? -2400 },
        level: { kind: 'observed' as const, percent: overrides.percent ?? 64 },
      }
      : { kind: 'none' as const }),
  });
  const batteryDevice = (storageHold: DevicePlanDevice['storageHold'] = 'none') => buildPlanDevice({
    id: 'battery-1',
    name: 'Sessy battery',
    isBatteryOrSolar: true,
    storageHold,
  });

  it('says a battery PELS holds for the limit is supplying, without a sign', () => {
    const card = buildSettingsOverviewDeviceReadModel(batteryDevice('relief'), battery());
    expect(card.status).toMatchObject({
      label: 'Supplying',
      kind: 'active',
      powerText: '2.4 kW',
      factText: '64 % charged',
      reason: { text: 'Holding your limit so your devices keep running' },
      limited: false,
    });
    expect(card.homeBattery).toEqual({ activity: 'supplying', power: { kind: 'observed', kw: 2.4 }, holdsLimit: true });
  });

  it('names what a battery held for the limit still does, not what the plan asked', () => {
    const card = buildSettingsOverviewDeviceReadModel(batteryDevice('relief'), battery({ signedW: 1500 }));
    expect(card.status).toMatchObject({
      label: 'Charging',
      powerText: '1.5 kW',
      reason: { text: 'Holding your limit so your devices keep running' },
    });
    // The hero names only a battery that is supplying.
    expect(card.homeBattery).toEqual({ activity: 'charging', power: { kind: 'observed', kw: 1.5 }, holdsLimit: false });
  });

  it.each([
    { name: 'too little to name', signedW: -30 },
    { name: 'no power reading', signedW: null },
  ])('gives a held battery reporting $name no power, so the hero has no figure', ({ signedW }) => {
    const card = buildSettingsOverviewDeviceReadModel(batteryDevice('relief'), battery({ signedW }));
    expect(card.status).toMatchObject({ label: 'Supplying', powerText: null });
    expect(card.homeBattery).toEqual({ activity: 'supplying', power: { kind: 'absent' }, holdsLimit: false });
  });

  it('says a battery PELS holds to store solar is charging from solar', () => {
    const card = buildSettingsOverviewDeviceReadModel(batteryDevice('surplus'), battery({ signedW: 1800, percent: 41 }));
    expect(card.status).toMatchObject({
      label: 'Charging',
      powerText: '1.8 kW',
      reason: { text: 'Storing the solar power your devices leave' },
    });
  });

  it('says a battery PELS caps for a device is charging less, never storing solar', () => {
    const card = buildSettingsOverviewDeviceReadModel(batteryDevice('cap_for_device'), battery({ signedW: 600 }));
    expect(card.status).toMatchObject({
      label: 'Charging',
      powerText: '0.6 kW',
      reason: { text: 'Charging less so a device can use the solar' },
    });
  });

  it('says a battery in its own mode is in its own mode, with what it is doing', () => {
    const card = buildSettingsOverviewDeviceReadModel(batteryDevice(), battery({ signedW: -400, percent: 78 }));
    expect(card.status).toMatchObject({
      label: 'Own mode',
      kind: 'idle',
      powerText: '0.4 kW',
      factText: '78 % charged · supplying',
      reason: { text: 'PELS takes over when your limit or solar needs it' },
    });
    expect(card.homeBattery).toEqual({ activity: 'own_mode', power: { kind: 'observed', kw: 0.4 }, holdsLimit: false });
  });

  it('gives a battery PELS cannot drive no promise of taking over', () => {
    const card = buildSettingsOverviewDeviceReadModel(batteryDevice(), battery({ drivable: false }));
    expect(card.status.reason).toBeNull();
  });

  it('shows a managed battery on the overview and never a solar device', () => {
    const readModel = buildSettingsOverviewReadModel({
      meta: buildPlanMeta({}),
      devices: [
        batteryDevice('relief'),
        buildPlanDevice({ id: 'pv-1', name: 'Roof', isBatteryOrSolar: true }),
      ],
    }, battery());
    expect(readModel?.devices?.map((device) => device.id)).toEqual(['battery-1']);
  });
});
