import { resolveTaskDeliveryControl } from '../../lib/plan/taskDeliveryControl';
import { resolveDeviceExecutionState } from '../../lib/executor/deviceExecutionState';
import { buildExecutableDeviceIntent, buildExecutableObservedDeviceStateFromSnapshot } from '../../lib/executor/executablePlanProjection';
import { buildDriftObservedSnapshot } from '../../lib/executor/driftObservedDevice';
import type { ExecutorDeviceRead } from '../../lib/executor/executorDeviceRead';
// Multi-owner integration reproduction: relay on/off + measured watts, or EV SoC +
// car charge limit, with real lifecycle, diagnostics, allocation, energy and
// history recorders. No allocator milestone or internal status is supplied.
import { describe, expect, it } from 'vitest';
import { DeferredObjectiveLifecycleEmitter } from '../../lib/objectives/deferredObjectives/lifecycleEmitter';
import { DeferredObjectivePlanHistoryRecorder, type PlanHistoryLoadResult } from '../../lib/objectives/deferredObjectives/planHistory';
import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import { EnergyTaskDeliveryTracker } from '../../lib/objectives/deferredObjectives/energyDelivery';
import { buildDeferredObjectiveDiagnostics } from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';
import type { CombinedPricesV2 } from '../../lib/price/priceTypes';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import type { DeferredObjectiveSettingsV1 } from '../../packages/contracts/src/deferredObjectiveSettings';
import type { DeferredObjectiveActivePlansV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectivePlanRevisionEvent } from '../../lib/objectives/deferredObjectives/planRevisionBus';
import type { TaskDeliveryControl } from '../../packages/contracts/src/taskDelivery';
import { effectivePlanStatusOf } from '../../lib/objectives/deferredObjectives/effectivePlanStatusEvents';
import {
  resolveReportedCarChargeLimit,
  resolveSmartTaskListStatus,
  resolveSmartTaskWidgetDetailCopy,
} from '../../packages/shared-domain/src/deadlineLabels';
import { normalizeDeferredObjectiveSettings } from '../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { resolveDeferredPlanHistoryMissAttribution } from '../../packages/shared-domain/src/deferredPlanHistoryAttribution';
import { type MeteredPlanInputDevice, withBinaryDiscriminant } from '../../lib/plan/planTypes';
import { buildPlanDevice, fixtureControlPosture, withFixtureResidualKw } from '../utils/planTestUtils';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { createFixturePriorityQuery } from '../helpers/modePriorityFixtures';
import { createMemoryEnergyDeliveryStore, inertPlanHistoryDeps, noDeviceExclusion, noStallEvidence } from '../helpers/deferredObjectiveWiringFixtures';

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const START_MS = Date.UTC(2026, 0, 1, 17);
const DEADLINE_MS = START_MS + 4 * HOUR_MS;
const HIGH_ID = 'heater-relay';
const LOW_ID = 'second-relay';

type Device = MeteredPlanInputDevice & {
  thermalDirection: 'heating'; stateOfCharge?: ReturnType<typeof stateOfChargeFixture>;
};
const relay = (id: string, drawKw: number, nowMs: number): Device => withBinaryDiscriminant(withFixtureResidualKw({
  id, name: id, available: true, currentDrawKw: drawKw,
  expectedPowerKw: 2, expectedPowerSource: 'measured-peak',
  commandableNow: true, objectiveSessionInactive: false,
  boostSupported: false, boostRequested: false,
  hasStandingDemand: true, surplusTracking: false, confirmedNotDrawing: false,
  targets: [], binaryCapabilityId: 'onoff', binaryControl: { on: true },
  control: fixtureControlPosture({ controllable: true }),
  deviceType: 'onoff', lastFreshDataMs: nowMs, thermalDirection: 'heating',
})) as unknown as Device;

const charger = (percent: number, limitPercent: number, drawKw: number, nowMs: number): Device => {
  const snapshot = stateOfChargeFixture({ percent, observedAtMs: nowMs, carId: 'car' });
  return {
    ...relay(HIGH_ID, drawKw, nowMs),
    isEvCharger: true,
    stateOfCharge: {
      ...snapshot,
      source: { kind: 'car', carId: 'car', chargeLimitPercent: limitPercent },
      level: { kind: 'known', percent, observedAtMs: nowMs, carChargeLimitPercent: limitPercent },
    },
  };
};

const prices: CombinedPricesV2 = {
  version: 2,
  days: {
    '2026-01-01': {
      hours: Array.from({ length: 24 }, (_, hour) => ({
        startsAt: new Date(Date.UTC(2026, 0, 1, hour)).toISOString(),
        total: 10, isCheap: false, isExpensive: false,
      })),
    },
  },
  avgPrice: 10, lowThreshold: 5, highThreshold: 15,
  priceScheme: 'norway', priceUnit: 'øre/kWh',
};
const priceHorizon = (nowMs: number, deadlineMs: number) => buildPriceHorizonFromCombined(prices, nowMs, deadlineMs);
const priorities = createFixturePriorityQuery([{ id: HIGH_ID, priority: 1 }, { id: LOW_ID, priority: 2 }]);

const energySettings = (): DeferredObjectiveSettingsV1 => normalizeDeferredObjectiveSettings({
  version: 1,
  objectivesByDeviceId: {
    [HIGH_ID]: { enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 6, deadlineAtMs: DEADLINE_MS },
    [LOW_ID]: { enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 4, deadlineAtMs: DEADLINE_MS },
  },
});
// One task, half the window's room: the earliest hours are claimed (flat
// prices tie-break earlier first) and the plan has margin.
const claimedEnergySettings = (): DeferredObjectiveSettingsV1 => normalizeDeferredObjectiveSettings({
  version: 1,
  objectivesByDeviceId: {
    [HIGH_ID]: { enabled: true, kind: 'energy', enforcement: 'soft', targetEnergyKWh: 4, deadlineAtMs: DEADLINE_MS },
  },
});
const evSettings = (): DeferredObjectiveSettingsV1 => normalizeDeferredObjectiveSettings({
  version: 1,
  objectivesByDeviceId: {
    [HIGH_ID]: { enabled: true, kind: 'ev_soc', enforcement: 'soft', targetPercent: 80, deadlineAtMs: DEADLINE_MS },
  },
});

// Stores are the external persistence seam. Restart constructs fresh owners
// against the same durable rows; no observation/time anchor is injected.
const createScenario = (settings: DeferredObjectiveSettingsV1) => {
  const energyStore = createMemoryEnergyDeliveryStore();
  let persistedHistory: PlanHistoryLoadResult = {
    snapshot: { version: 6, entries: [] }, persistenceSafe: true, meteredDeliveryStates: [],
  };
  let persistedActive: DeferredObjectiveActivePlansV1 | null = null;
  let devices: Device[] = [];
  let reported: DeferredObjectiveDiagnostic[] = [];
  let active: DeferredObjectiveActivePlanRecorder;
  let history: DeferredObjectivePlanHistoryRecorder;
  let energy: EnergyTaskDeliveryTracker;
  let lifecycle: DeferredObjectiveLifecycleEmitter;
  // The plan owner's decision for the task's device, when a case drives one
  // (a capacity shed, a settle). Absent, the device runs at PELS' requested
  // setting, resolved through the real control resolver below.
  let planDecision: TaskDeliveryControl | null = null;
  const revisionEvents: DeferredObjectivePlanRevisionEvent[] = [];
  const powerTracker = {
    objectiveProfiles: {
      [HIGH_ID]: {
        updatedAtMs: START_MS,
        lastSample: { observedAtMs: START_MS, value: 60 },
        kwhPerUnit: { sampleCount: 8, mean: 0.2, m2: 0, min: 0.2, max: 0.2, confidence: 'high' as const, lastUpdatedMs: START_MS },
        acceptedSamples: 8, rejectedSamples: 0,
      },
    },
  };
  const restart = () => {
    energy = new EnergyTaskDeliveryTracker(energyStore, () => true);
    active = new DeferredObjectiveActivePlanRecorder({
      load: () => persistedActive, save: (value) => { persistedActive = value; return true; },
      onRevisionWritten: (event) => { revisionEvents.push(event); },
    });
    history = new DeferredObjectivePlanHistoryRecorder({
      ...inertPlanHistoryDeps(),
      // The simulated relay/charger remains on at PELS' requested setting.
      // Whole-home control is not imposing any lower setting in this case.
      getDeliveryControl: (deviceId) => {
        const device = devices.find((entry) => entry.id === deviceId);
        if (!device) return { kind: 'no_decision' };
        if (planDecision !== null && deviceId === HIGH_ID) return planDecision;
        const planDevice = buildPlanDevice({
          id: device.id, name: device.name, deviceType: 'onoff',
          currentOn: true, currentState: 'on', plannedState: 'keep',
          binaryCapabilityId: 'onoff', control: fixtureControlPosture({ controllable: true }),
        });
        const observed = buildExecutableObservedDeviceStateFromSnapshot(buildDriftObservedSnapshot({
          id: device.id, name: device.name, available: true, isEvCharger: false,
          targets: [], binaryControl: { on: true },
        } as ExecutorDeviceRead, undefined));
        return resolveTaskDeliveryControl(planDevice, resolveDeviceExecutionState(
          buildExecutableDeviceIntent(planDevice), observed,
          { binary: { kind: 'none' }, step: { kind: 'none' }, target: null }, false,
        ));
      },
      // Device-owner semantic port; the car correlation and qualified-limit
      // production path is covered by evCarLinkProducer.test.ts.
      getDeviceConstraint: (deviceId) => {
        const device = devices.find((entry) => entry.id === deviceId);
        const level = device?.stateOfCharge?.level;
        return device?.currentDrawKw === 0 && level?.kind === 'known'
          && level.carChargeLimitPercent !== undefined && level.percent >= level.carChargeLimitPercent
          ? { kind: 'limit_reached' } : { kind: 'none' };
      },
      load: () => persistedHistory,
      save: (snapshot, meteredDeliveryStates) => {
        persistedHistory = JSON.parse(JSON.stringify({ snapshot, meteredDeliveryStates, persistenceSafe: true }));
        return true;
      },
    });
    lifecycle = new DeferredObjectiveLifecycleEmitter({
      getThermalDirection: () => 'heating',
      getDeferredObjectiveSettings: () => settings,
      getTimeZone: () => 'UTC', getDevices: () => devices,
      getPowerTracker: () => powerTracker, getDailyBudgetSnapshot: () => null,
      buildPriceHorizon: priceHorizon, getPriceOptimizationEnabled: () => true,
      getDeferredObjectiveActivePlans: () => active.getActivePlansSnapshot(),
      getCapacitySettings: () => ({ limitKw: 2, marginKw: 0, periodMinutes: 60 }),
      getPrioritiesForDevices: priorities,
      resolveDeviceExclusion: noDeviceExclusion, getStallClassification: noStallEvidence,
      energyDelivery: energy, isReservationSuppressed: history.isReservationSuppressed,
      getDeliveryEvidence: history.getDeliveryEvidence,
      observeDeferredObjectivePlanHistory: (diagnostics, nowMs, activePlans) => history.observe(diagnostics, nowMs, activePlans),
      observeDeferredObjectiveActivePlans: (diagnostics, nowMs) => {
        reported = diagnostics;
        active.observe(diagnostics, nowMs);
      },
    });
  };
  restart();
  const tick = (nowMs: number, observed: Device[]) => {
    devices = observed;
    lifecycle.tick(nowMs);
    history.flushIfDirty();
    active.flushIfDirty();
    energy.flushIfDirty();
    return reported;
  };
  const build = (nowMs: number) => buildDeferredObjectiveDiagnostics({
    nowMs, timeZone: 'UTC', devices, settings, powerTracker,
    dailyBudgetSnapshot: null, buildPriceHorizon: priceHorizon,
    priceOptimizationEnabled: true, sustainableRateKw: 2,
    activePlans: active.getActivePlansSnapshot(), getPrioritiesForDevices: priorities,
    resolveDeviceExclusion: noDeviceExclusion, getStallClassification: noStallEvidence,
    getDeliveredEnergyKWh: energy.getDeliveredKWh, isReservationSuppressed: history.isReservationSuppressed,
  });
  return {
    tick, build, restart,
    setPlanDecision: (control: TaskDeliveryControl | null) => { planDecision = control; },
    revisionEvents: () => [...revisionEvents],
    activePlan: () => {
      const plan = active.getActivePlansSnapshot()?.plansByDeviceId[HIGH_ID];
      if (!plan) throw new Error('Missing active plan');
      return plan;
    },
    evidence: () => history.getDeliveryEvidence(HIGH_ID, DEADLINE_MS),
    reservationSuppressed: () => history.isReservationSuppressed(HIGH_ID, DEADLINE_MS),
    delivered: () => energy.getDeliveredKWh(HIGH_ID, DEADLINE_MS),
    archive: () => history.getHistorySnapshot(),
    persisted: () => persistedHistory,
  };
};
const task = (diagnostics: DeferredObjectiveDiagnostic[], id: string) => {
  const diagnostic = diagnostics.find((entry) => entry.deviceId === id);
  if (!diagnostic) throw new Error(`Missing diagnostic for ${id}`);
  return diagnostic;
};
const plannedKWh = (diagnostic: DeferredObjectiveDiagnostic) => diagnostic.horizonPlan?.plannedUsefulEnergyKWh ?? 0;


describe('task delivery evidence at the device boundary', () => {
  it('keeps a relay energy task unmet at its mechanical cutoff, releases reservations, and recovers when drawing resumes', () => {
    const scenario = createScenario(energySettings());
    const observed = (atMs: number, highKw: number) => [relay(HIGH_ID, highKw, atMs), relay(LOW_ID, 0, atMs)];
    for (let minutes = 0; minutes < 20; minutes += 5) {
      scenario.tick(START_MS + minutes * MIN_MS, observed(START_MS + minutes * MIN_MS, 2));
    }
    const stoppedAt = START_MS + 20 * MIN_MS;
    scenario.tick(stoppedAt, observed(stoppedAt, 0));
    const before = plannedKWh(task(scenario.build(stoppedAt), LOW_ID));
    const beforeCount = scenario.delivered();
    expect(beforeCount).toBeGreaterThan(0);
    expect(beforeCount).toBeLessThan(6);
    for (let minutes = 25; minutes < 35; minutes += 5) {
      scenario.tick(START_MS + minutes * MIN_MS, observed(START_MS + minutes * MIN_MS, 0));
    }
    expect(scenario.evidence().nonDelivery.kind).toBe('watching');
    const confirmedAt = START_MS + 35 * MIN_MS;
    const confirmed = task(scenario.tick(confirmedAt, observed(confirmedAt, 0)), HIGH_ID);
    expect(confirmed.trajectory).toEqual({ kind: 'resolved', status: 'at_risk' });
    expect(confirmed.reasonCode).toBe('objective_not_accepting_energy');
    // The persisted plan every surface reads carries the confirmed cause, and the
    // list chip and widget row say what the device needs, not "limited time".
    const plan = scenario.activePlan();
    expect(plan.diagnosticReasonCode).toBe('objective_not_accepting_energy');
    const statusId = resolveSmartTaskListStatus({
      pending: plan.pending, pendingReason: plan.pendingReason, diagnosticReasonCode: plan.diagnosticReasonCode,
      planStatus: plan.latest?.planStatus, firstActionAtMs: null, nowMs: confirmedAt,
      carChargeLimit: resolveReportedCarChargeLimit(plan),
      liveCompletion: plan.liveCompletion,
    });
    expect(statusId).toBe('at_risk');
    expect(effectivePlanStatusOf(plan)).toBe('at_risk');
    expect(resolveSmartTaskWidgetDetailCopy({ statusId, diagnosticReasonCode: plan.diagnosticReasonCode }))
      .toEqual({ whyLabel: 'Device stopped taking power.', recourseHint: null });
    expect(confirmed.currentValue).toBeCloseTo(beforeCount);
    expect(scenario.evidence().explanation).toMatchObject({
      kind: 'recorded', primary: { kind: 'blocked', cause: 'device_not_accepting' },
    });
    expect(scenario.evidence().nonDelivery.kind).toBe('confirmed');
    const decision = applyDeferredObjectiveAdmission((scenario.build(confirmedAt)).map((diagnostic) => diagnostic.evaluation), observed(confirmedAt, 0)).get(HIGH_ID);
    expect(decision?.kind).toBe('planned');

    // Lower tasks acquire the freed physical room at the ordinary :58 settle.
    const settleAt = START_MS + 58 * MIN_MS;
    scenario.tick(settleAt, observed(settleAt, 0));
    const freed = plannedKWh(task(scenario.build(settleAt), LOW_ID));
    expect(freed).toBeGreaterThan(before);

    const resumedAt = START_MS + HOUR_MS;
    scenario.tick(resumedAt, observed(resumedAt, 2));
    expect(scenario.evidence().nonDelivery.kind).toBe('none');
    expect(scenario.evidence().explanation).toMatchObject({ kind: 'recorded', primary: { kind: 'clear' } });
    const nextSettle = START_MS + HOUR_MS + 58 * MIN_MS;
    scenario.tick(nextSettle, observed(nextSettle, 2));
    expect(scenario.delivered()).toBeGreaterThan(beforeCount);
    expect(plannedKWh(task(scenario.build(nextSettle), LOW_ID))).toBeLessThan(freed);
  });

  it('keeps a claimed hour on track through capacity shed and settle cycles, with no status event', () => {
    // Production: an EV task 3 h from its deadline, shed by the house capacity
    // limit in its claimed hour, flipped At risk <-> On track on every
    // shed/cooldown cycle and fired the status Flow trigger each time. Capacity
    // limiting and settles are PELS' own decisions, which the plan prices in.
    const scenario = createScenario(claimedEnergySettings());
    const observed = (atMs: number, kw: number) => [relay(HIGH_ID, kw, atMs)];
    const first = task(scenario.tick(START_MS, observed(START_MS, 2)), HIGH_ID);
    expect(first.trajectory).toEqual({ kind: 'resolved', status: 'on_track' });
    expect(first.evaluation.planning.kind === 'allocated'
      && first.evaluation.planning.plan.currentHourClaim).toBe('claimed');
    const eventsBefore = scenario.revisionEvents().length;
    const cycle: { control: TaskDeliveryControl; kw: number }[] = [
      { control: { kind: 'restricted', cause: 'capacity_limited' }, kw: 0 },
      { control: { kind: 'pending' }, kw: 0 },
      { control: { kind: 'restricted', cause: 'budget_limited' }, kw: 0 },
      { control: { kind: 'restricted', cause: 'priority_limited' }, kw: 0 },
      { control: { kind: 'failed' }, kw: 0 },
      { control: { kind: 'permitted' }, kw: 2 },
    ];
    // Stays inside the hour: the :58 settle is the plan's own chance to re-plan.
    for (let step = 1; step <= 24; step += 1) {
      const atMs = START_MS + step * 2 * MIN_MS;
      const decision = cycle[step % cycle.length];
      if (!decision) throw new Error('Missing cycle step');
      const { control, kw } = decision;
      scenario.setPlanDecision(control);
      const diagnostic = task(scenario.tick(atMs, observed(atMs, kw)), HIGH_ID);
      expect(diagnostic.trajectory).toEqual({ kind: 'resolved', status: 'on_track' });
      expect(scenario.activePlan().diagnosticReasonCode).toBeUndefined();
      expect(effectivePlanStatusOf(scenario.activePlan())).toBe('on_track');
    }
    // No status change reaches the "Smart task status changed" Flow trigger.
    expect(scenario.revisionEvents().slice(eventsBefore).filter((event) => event.eventType === 'revision_written'
      && event.effectivePlanStatus !== undefined && event.effectivePlanStatus !== event.previousPlanStatus)).toEqual([]);
    // The holds still count as delivery evidence for the past-task explanation.
    expect(scenario.evidence().explanation).toMatchObject({
      kind: 'recorded', contributors: expect.arrayContaining(['capacity_limited', 'control_pending']),
    });
  });

  it('keeps a device that stopped taking power at risk through PELS\'s own holds, with one status event', () => {
    // A water heater at its own thermostat cutoff is confirmed after 15 minutes
    // of permitted delivery. A shed or settle tick afterwards is PELS's own
    // decision and no evidence the device would draw: the status must not flip
    // back to on track and fire the status Flow again each time.
    const scenario = createScenario(claimedEnergySettings());
    const observed = (atMs: number, kw: number) => [relay(HIGH_ID, kw, atMs)];
    scenario.tick(START_MS, observed(START_MS, 2));
    const eventsBefore = scenario.revisionEvents().length;
    scenario.setPlanDecision({ kind: 'permitted' });
    for (let minutes = 2; minutes <= 18; minutes += 2) {
      scenario.tick(START_MS + minutes * MIN_MS, observed(START_MS + minutes * MIN_MS, 0));
    }
    expect(scenario.evidence().nonDelivery.kind).toBe('confirmed');
    expect(scenario.activePlan().diagnosticReasonCode).toBe('objective_not_accepting_energy');
    expect(scenario.reservationSuppressed()).toBe(true);

    const holds: TaskDeliveryControl[] = [
      { kind: 'restricted', cause: 'capacity_limited' }, { kind: 'pending' },
      { kind: 'restricted', cause: 'budget_limited' }, { kind: 'permitted' },
    ];
    for (let step = 1; step <= 12; step += 1) {
      const atMs = START_MS + (18 + step * 2) * MIN_MS;
      const control = holds[step % holds.length];
      if (!control) throw new Error('Missing hold step');
      scenario.setPlanDecision(control);
      scenario.tick(atMs, observed(atMs, 0));
      expect(scenario.activePlan().diagnosticReasonCode).toBe('objective_not_accepting_energy');
      expect(effectivePlanStatusOf(scenario.activePlan())).toBe('at_risk');
      // A hold keeps the stop for the status but holds the room again; the next
      // permitted window re-tests the device before freeing it.
      expect(['stopped', 'rechecking']).toContain(scenario.evidence().nonDelivery.kind);
      expect(scenario.reservationSuppressed()).toBe(false);
    }
    const flips = () => scenario.revisionEvents().slice(eventsBefore).filter((event) => (
      event.eventType === 'revision_written' && event.effectivePlanStatus !== undefined
      && event.effectivePlanStatus !== event.previousPlanStatus
    ));
    expect(flips().map((event) => event.effectivePlanStatus)).toEqual(['at_risk']);

    // A full permitted window re-confirms the stop and frees the room again,
    // with no second status event.
    scenario.setPlanDecision({ kind: 'permitted' });
    for (let minutes = 44; minutes <= 60; minutes += 2) {
      const atMs = START_MS + minutes * MIN_MS;
      scenario.tick(atMs, observed(atMs, 0));
    }
    expect(scenario.evidence().nonDelivery.kind).toBe('confirmed');
    expect(flips().map((event) => event.effectivePlanStatus)).toEqual(['at_risk']);
    expect(scenario.reservationSuppressed()).toBe(true);

    // Drawing again ends the stop on the same tick, and the Flow hears it.
    const resumedAt = START_MS + 62 * MIN_MS;
    scenario.setPlanDecision({ kind: 'permitted' });
    scenario.tick(resumedAt, observed(resumedAt, 2));
    expect(scenario.evidence().nonDelivery.kind).toBe('none');
    expect(scenario.reservationSuppressed()).toBe(false);
    expect(scenario.activePlan().diagnosticReasonCode).toBeUndefined();
    expect(effectivePlanStatusOf(scenario.activePlan())).toBe('on_track');
    expect(flips().map((event) => event.effectivePlanStatus)).toEqual(['at_risk', 'on_track']);
  });

  it('keeps a stop across a restart, in a form older builds can read, and re-tests before freeing the room', () => {
    const scenario = createScenario(claimedEnergySettings());
    const observed = (atMs: number, kw: number) => [relay(HIGH_ID, kw, atMs)];
    scenario.tick(START_MS, observed(START_MS, 2));
    for (let minutes = 2; minutes <= 18; minutes += 2) {
      scenario.tick(START_MS + minutes * MIN_MS, observed(START_MS + minutes * MIN_MS, 0));
    }
    scenario.setPlanDecision({ kind: 'restricted', cause: 'capacity_limited' });
    scenario.tick(START_MS + 20 * MIN_MS, observed(START_MS + 20 * MIN_MS, 0));
    expect(scenario.evidence().nonDelivery.kind).toBe('stopped');
    expect(scenario.persisted().meteredDeliveryStates.find((row) => row.deviceId === HIGH_ID)
      ?.deliveryEvidence.nonDelivery.kind).toBe('confirmed');

    scenario.restart();
    expect(scenario.evidence().nonDelivery.kind).toBe('stopped');
    scenario.setPlanDecision({ kind: 'permitted' });
    const restoredAt = START_MS + 25 * MIN_MS;
    scenario.tick(restoredAt, observed(restoredAt, 0));
    expect(scenario.evidence().nonDelivery.kind).toBe('rechecking');
    expect(scenario.activePlan().diagnosticReasonCode).toBe('objective_not_accepting_energy');
  });

  it('names the owner\'s off action for a device held off in its claimed hour', () => {
    // "Leave off until turned on again" reaches the delivery owner as
    // `uncontrolled`. The surfaces must still say the device is being left off,
    // not report a generic delivery restriction or limited time.
    const scenario = createScenario(claimedEnergySettings());
    scenario.tick(START_MS, [relay(HIGH_ID, 2, START_MS)]);
    scenario.setPlanDecision({ kind: 'uncontrolled' });
    for (let minutes = 5; minutes <= 30; minutes += 5) {
      const atMs = START_MS + minutes * MIN_MS;
      scenario.tick(atMs, [{ ...relay(HIGH_ID, 0, atMs), externalOffHoldActive: true as const }]);
    }
    const plan = scenario.activePlan();
    expect(plan.diagnosticReasonCode).toBe('objective_device_left_off');
    expect(effectivePlanStatusOf(plan)).toBe('at_risk');
    expect(resolveSmartTaskWidgetDetailCopy({ statusId: 'at_risk', diagnosticReasonCode: plan.diagnosticReasonCode }))
      .toEqual({ whyLabel: 'Device is staying off until turned on again.', recourseHint: null });
  });

  it('persists a relay cutoff cause across restart and misses without inventing capacity pressure', () => {
    const scenario = createScenario(energySettings());
    for (let minutes = 0; minutes <= 20; minutes += 5) {
      const atMs = START_MS + minutes * MIN_MS;
      scenario.tick(atMs, [relay(HIGH_ID, 0, atMs), relay(LOW_ID, 0, atMs)]);
    }
    expect(scenario.evidence().nonDelivery.kind).toBe('confirmed');
    expect(scenario.persisted().meteredDeliveryStates.find((row) => row.deviceId === HIGH_ID)?.deliveryEvidence.explanation)
      .toMatchObject({ kind: 'recorded', primary: { kind: 'blocked', cause: 'device_not_accepting' } });
    scenario.restart();
    // The stop survives for the status; its room is held again until re-tested.
    expect(scenario.evidence().nonDelivery.kind).toBe('stopped');
    const restoredAt = START_MS + 25 * MIN_MS;
    scenario.tick(restoredAt, [relay(HIGH_ID, 0, restoredAt), relay(LOW_ID, 0, restoredAt)]);
    // Restart resumes fresh observation instead of billing or counting its gap.
    expect(scenario.delivered()).toBe(0);
    expect(scenario.evidence().nonDelivery.kind).toBe('rechecking');
    for (let atMs = restoredAt + 5 * MIN_MS; atMs < DEADLINE_MS; atMs += 5 * MIN_MS) {
      scenario.tick(atMs, [relay(HIGH_ID, 0, atMs), relay(LOW_ID, 0, atMs)]);
    }
    scenario.tick(DEADLINE_MS, [relay(HIGH_ID, 0, DEADLINE_MS), relay(LOW_ID, 0, DEADLINE_MS)]);
    const archived = scenario.archive().entries.find((entry) => entry.deviceId === HIGH_ID);
    expect(archived?.outcome).toBe('missed');
    expect(archived?.deliveryExplanation).toMatchObject({
      kind: 'recorded', primary: { kind: 'blocked', cause: 'device_not_accepting' },
    });
    expect(JSON.stringify(archived?.deliveryExplanation)).not.toContain('capacity_limited');
    expect(archived && resolveDeferredPlanHistoryMissAttribution(archived)?.cause).toBe('device_not_accepting');
  });

  it('keeps the requested 80% unmet at the car’s 70% limit and clears the limit blocker when charging resumes', () => {
    const scenario = createScenario(evSettings());
    scenario.tick(START_MS, [charger(60, 70, 2, START_MS)]);
    const stoppedAt = START_MS + 30 * MIN_MS;
    const stopped = task(scenario.tick(stoppedAt, [charger(70, 70, 0, stoppedAt)]), HIGH_ID);
    expect(stopped.targetValue).toBe(80);
    expect(stopped.reachableTargetValue).toBe(70);
    expect(stopped.trajectory).not.toEqual({ kind: 'resolved', status: 'satisfied' });
    expect(stopped.reasonCode).toBe('objective_device_limit');
    expect(scenario.evidence().explanation).toMatchObject({
      kind: 'recorded', primary: { kind: 'blocked', cause: 'device_limit' },
    });
    const resumedAt = stoppedAt + 20 * MIN_MS;
    scenario.tick(resumedAt, [charger(71, 80, 2, resumedAt)]);
    expect(scenario.evidence().explanation).toMatchObject({ kind: 'recorded', primary: { kind: 'clear' } });
    const doneAt = START_MS + 2 * HOUR_MS;
    const done = task(scenario.tick(doneAt, [charger(80, 80, 0, doneAt)]), HIGH_ID);
    expect(done.trajectory).toEqual({ kind: 'resolved', status: 'satisfied' });
    scenario.tick(DEADLINE_MS, [charger(80, 80, 0, DEADLINE_MS)]);
    expect(scenario.archive().entries.find((entry) => entry.deviceId === HIGH_ID)?.outcome).toBe('met');
  });
  it('archives the lower car limit as the cause when the requested EV target remains unmet', () => {
    const scenario = createScenario(evSettings());
    scenario.tick(START_MS, [charger(60, 70, 2, START_MS)]);
    for (let atMs = START_MS + 30 * MIN_MS; atMs < DEADLINE_MS; atMs += 5 * MIN_MS) {
      scenario.tick(atMs, [charger(70, 70, 0, atMs)]);
    }
    scenario.tick(DEADLINE_MS, [charger(70, 70, 0, DEADLINE_MS)]);
    const archived = scenario.archive().entries.find((entry) => entry.deviceId === HIGH_ID);
    expect(archived).toMatchObject({ outcome: 'missed', targetValue: 80, finalProgressValue: 70 });
    expect(archived?.deliveryExplanation).toMatchObject({
      kind: 'recorded', primary: { kind: 'blocked', cause: 'device_limit' },
    });
    expect(JSON.stringify(archived?.deliveryExplanation)).not.toContain('capacity_limited');
    expect(archived && resolveDeferredPlanHistoryMissAttribution(archived).cause).toBe('device_limit');
  });

});
