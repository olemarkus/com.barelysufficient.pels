import {
  DeferredObjectiveActivePlanRecorder,
  type ActivePlanFlowCardSeed,
  type ActivePlanPersistDeps,
} from '../lib/plan/deferredObjectives/activePlanRecorder';
import {
  normalizeDeferredObjectiveActivePlans,
} from '../lib/plan/deferredObjectives/activePlanSettings';
import type {
  DeferredObjectiveDiagnostic,
  DeferredObjectiveHorizonPlan,
  DeferredObjectivePlannedBucket,
} from '../lib/plan/deferredObjectives';
import type {
  DeferredObjectiveActivePlansV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';

const HOUR_MS = 60 * 60 * 1000;

const makeBucket = (
  startMs: number,
  plannedUsefulEnergyKWh: number,
  overrides: Partial<DeferredObjectivePlannedBucket> = {},
): DeferredObjectivePlannedBucket => ({
  id: `b-${startMs}`,
  sourceBucketId: `s-${startMs}`,
  startMs,
  endMs: startMs + HOUR_MS,
  durationHours: 1,
  preference: 'neutral',
  policyScore: 0,
  reserve: false,
  current: false,
  usefulEnergyCapacityKWh: 3,
  plannedUsefulEnergyKWh,
  ...overrides,
});

const makeHorizon = (
  buckets: DeferredObjectivePlannedBucket[],
  overrides: Partial<DeferredObjectiveHorizonPlan> = {},
): DeferredObjectiveHorizonPlan => {
  const planned = buckets.reduce((sum, b) => sum + b.plannedUsefulEnergyKWh, 0);
  return {
    objectiveId: 'dev:temperature',
    kind: 'temperature',
    enforcement: 'soft',
    status: 'on_track',
    statusDetail: 'planned_with_margin',
    horizonStartMs: buckets[0]?.startMs ?? 0,
    horizonEndMs: buckets.at(-1)?.endMs ?? HOUR_MS,
    planningEndMs: buckets.at(-1)?.endMs ?? HOUR_MS,
    deadlineMarginMs: 0,
    energyNeededKWh: planned,
    plannedUsefulEnergyKWh: planned,
    unplannedUsefulEnergyKWh: 0,
    requestedMinimumStepId: 'low',
    currentBucket: null,
    plannedBuckets: buckets,
    usesDeadlineReserve: false,
    usesPolicyAvoid: false,
    ...overrides,
  };
};

const makeDiag = (overrides: Partial<DeferredObjectiveDiagnostic> & {
  deviceId: string;
  deadlineAtMs: number;
}): DeferredObjectiveDiagnostic => ({
  deviceId: overrides.deviceId,
  deviceName: 'Water Heater',
  objectiveId: `${overrides.deviceId}:temperature`,
  objectiveKind: 'temperature',
  enforcement: 'soft',
  status: 'on_track',
  reasonCode: 'planned_with_margin',
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: 65,
  currentTemperatureC: 50,
  deadlineAtMs: overrides.deadlineAtMs,
  deadlineLocalTime: '06:00',
  energyNeededKWh: 4.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 1.5,
  rateConfidence: 'high',
  kwhPerUnitSource: 'learned',
  horizonBucketCount: 3,
  dailyBudgetExhaustedBucketCount: 0,
  requestedMinimumStepId: 'low',
  horizonPlan: makeHorizon([
    makeBucket(2 * HOUR_MS, 1.5),
    makeBucket(3 * HOUR_MS, 1.5),
    makeBucket(4 * HOUR_MS, 1.5),
  ]),
  ...overrides,
});

const buildSeed = (overrides: Partial<ActivePlanFlowCardSeed> = {}): ActivePlanFlowCardSeed => ({
  deviceId: 'dev',
  deviceName: 'Water Heater',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: 6 * HOUR_MS,
  enforcement: 'soft',
  ...overrides,
});

const buildPersistDeps = (initial?: DeferredObjectiveActivePlansV1): {
  deps: ActivePlanPersistDeps;
  saved: () => DeferredObjectiveActivePlansV1 | null;
  saveCount: () => number;
} => {
  let saved: DeferredObjectiveActivePlansV1 | null = null;
  let saveCount = 0;
  return {
    deps: {
      load: () => initial ?? null,
      save: (next) => { saved = next; saveCount += 1; },
    },
    saved: () => saved,
    saveCount: () => saveCount,
  };
};

describe('DeferredObjectiveActivePlanRecorder', () => {
  it('writes the first revision on first plannable diagnostic with reason flow_card', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(false);
    expect(plan.original?.revision).toBe(1);
    expect(plan.original?.reason).toBe('flow_card');
    expect(plan.latest?.hours).toEqual([
      { startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 3 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 4 * HOUR_MS, plannedKWh: 1.5 },
    ]);
    expect(plan.commitment).toEqual({
      committedAtMs: HOUR_MS,
      hours: plan.latest?.hours,
    });
  });

  it('marks pending when the flow card fires before any horizon plan exists', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.markPending(buildSeed(), 0);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.original).toBeNull();
    expect(plan.latest).toBeNull();
  });

  it('captures awaiting_horizon_plan on a pending record auto-created from a diagnostic with no horizon plan', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // Diagnostic without `horizonPlan` (e.g. price horizon doesn't cover the deadline).
    const diag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (diag as { horizonPlan?: unknown }).horizonPlan;
    diag.reasonCode = 'objective_missing_price_horizon';

    recorder.observe([diag], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('awaiting_horizon_plan');
  });

  it('captures device_data_missing on a pending record for progress/profile-side diagnostic failures', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    const diag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (diag as { horizonPlan?: unknown }).horizonPlan;
    diag.reasonCode = 'objective_missing_temperature';

    recorder.observe([diag], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('device_data_missing');
  });

  it('routes objective_missing_charge_rate to missing_capacity for a thermal objective', () => {
    // Production case (2026-05-17, Termostat kontor): PELS reads the current
    // temperature and has a learned kWh/°C but no calibrated planningPowerKw,
    // so `resolveObjectiveSteps` returns [] and the diagnostic emits
    // `objective_missing_charge_rate`. The pending hero must show the
    // "Learning energy use" copy, not "PELS can't read the current
    // temperature".
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    const diag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (diag as { horizonPlan?: unknown }).horizonPlan;
    diag.reasonCode = 'objective_missing_charge_rate';

    recorder.observe([diag], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('missing_capacity');
  });

  it('routes objective_missing_charge_rate to device_data_missing for an EV objective', () => {
    // EV `objective_missing_charge_rate` is a genuine missing reading from the
    // charger — keep the existing "Waiting for a reading" copy.
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    const diag = makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 80,
      currentTemperatureC: null,
      currentPercent: 40,
      kWhPerDegreeC: null,
      kWhPerPercent: 0.5,
    });
    delete (diag as { horizonPlan?: unknown }).horizonPlan;
    diag.reasonCode = 'objective_missing_charge_rate';

    recorder.observe([diag], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('device_data_missing');
  });

  it('captures invalid_session on a pending record when the EV is unplugged', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    const diag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (diag as { horizonPlan?: unknown }).horizonPlan;
    diag.reasonCode = 'objective_invalid_session';

    recorder.observe([diag], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('invalid_session');
  });

  it('refreshes pendingReason when the diagnostic flips from missing-temperature to missing-prices', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // First cycle: device hasn't reported a temperature yet.
    const tempMissing = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (tempMissing as { horizonPlan?: unknown }).horizonPlan;
    tempMissing.reasonCode = 'objective_missing_temperature';
    recorder.observe([tempMissing], HOUR_MS);

    // Next cycle: temperature arrived but price horizon does not yet cover the deadline.
    const horizonMissing = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (horizonMissing as { horizonPlan?: unknown }).horizonPlan;
    horizonMissing.reasonCode = 'objective_missing_price_horizon';
    recorder.observe([horizonMissing], 2 * HOUR_MS);

    recorder.flushIfDirty();
    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('awaiting_horizon_plan');
  });

  it('captures price_feature_disabled on a pending record when the diagnostic indicates the feature is off', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    const diag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (diag as { horizonPlan?: unknown }).horizonPlan;
    diag.reasonCode = 'objective_price_feature_disabled';

    recorder.observe([diag], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('price_feature_disabled');
  });

  it('refreshes pendingReason on an existing pending record when the cause transitions', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // Seed via flow card — no pendingReason yet (no diagnostic context).
    recorder.markPending(buildSeed(), 0);

    const diag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (diag as { horizonPlan?: unknown }).horizonPlan;
    diag.reasonCode = 'objective_price_feature_disabled';

    recorder.observe([diag], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('price_feature_disabled');
  });

  it('sets diagnosticReasonCode to objective_invalid_session when the EV session is invalid', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    const diag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (diag as { horizonPlan?: unknown }).horizonPlan;
    diag.reasonCode = 'objective_invalid_session';

    recorder.observe([diag], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('invalid_session');
    expect(plan.diagnosticReasonCode).toBe('objective_invalid_session');
  });

  it('clears diagnosticReasonCode when the session becomes valid again', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // First cycle: EV is unplugged → invalid session.
    const invalidDiag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (invalidDiag as { horizonPlan?: unknown }).horizonPlan;
    invalidDiag.reasonCode = 'objective_invalid_session';
    recorder.observe([invalidDiag], HOUR_MS);
    recorder.flushIfDirty();

    expect(saved()!.plansByDeviceId.dev.diagnosticReasonCode).toBe('objective_invalid_session');

    // Second cycle: price horizon not yet available (generic pending, no specific code).
    const horizonMissingDiag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (horizonMissingDiag as { horizonPlan?: unknown }).horizonPlan;
    horizonMissingDiag.reasonCode = 'objective_missing_price_horizon';
    recorder.observe([horizonMissingDiag], 2 * HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.diagnosticReasonCode).toBeUndefined();
  });

  it('does not set diagnosticReasonCode for other device-data reason codes', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    const diag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (diag as { horizonPlan?: unknown }).horizonPlan;
    diag.reasonCode = 'objective_missing_temperature';

    recorder.observe([diag], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(true);
    expect(plan.pendingReason).toBe('device_data_missing');
    expect(plan.diagnosticReasonCode).toBeUndefined();
  });

  it('clears diagnosticReasonCode when a revision is written', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // First cycle: invalid session.
    const invalidDiag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    delete (invalidDiag as { horizonPlan?: unknown }).horizonPlan;
    invalidDiag.reasonCode = 'objective_invalid_session';
    recorder.observe([invalidDiag], HOUR_MS);
    recorder.flushIfDirty();
    expect(saved()!.plansByDeviceId.dev.diagnosticReasonCode).toBe('objective_invalid_session');

    // Next cycle: plan resolves with actual hours.
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], 2 * HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(false);
    expect(plan.diagnosticReasonCode).toBeUndefined();
  });

  it('transitions pending -> first revision with prices_arrived when prices show up', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.markPending(buildSeed(), 0);
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.pending).toBe(false);
    expect(plan.original?.reason).toBe('prices_arrived');
    expect(plan.latest?.reason).toBe('prices_arrived');
  });

  it('does not write a new revision when subsequent cycles produce identical hours', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    const firstRevision = recorder.getPlanForTests('dev')?.latest?.revision;
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], 2 * HOUR_MS);
    const secondRevision = recorder.getPlanForTests('dev')?.latest?.revision;

    expect(firstRevision).toBe(1);
    expect(secondRevision).toBe(1);
  });

  it('emits an objective_changed revision when the target temperature changes mid-flight', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      targetTemperatureC: 70,
      // Different bucket plan reflects the larger delta:
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 2.0),
        makeBucket(3 * HOUR_MS, 2.0),
        makeBucket(4 * HOUR_MS, 2.0),
      ]),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('objective_changed');
    expect(plan?.latest?.revision).toBe(2);
    expect(plan?.original?.revision).toBe(1);
    expect(plan?.original?.hours[0]?.plannedKWh).toBe(1.5);
  });

  it('freezes initialPlanningSpeedKw and initialEstimatedDurationText at first-revision time', () => {
    // Regression for TODO 597: the recorder formats `estimatedDurationText`
    // from `energyNeededKWh / planningSpeedKw` on every revision and
    // `energyNeededKWh` shrinks every cycle as the device consumes energy
    // (`diagnosticsBridge.ts` recomputes it from `progress.remainingUnits`).
    // The plan-level total duration must stay frozen at first-revision time
    // so the hero meta line shows the user's original commitment, not the
    // shrinking remaining estimate.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // First revision: 4.5 kWh @ 1.5 kW → 3h.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      planningSpeedKw: 1.5,
    })], HOUR_MS);

    const firstPlan = recorder.getPlanForTests('dev');
    expect(firstPlan?.initialPlanningSpeedKw).toBe(1.5);
    expect(firstPlan?.initialEstimatedDurationText).toBe('3h');
    expect(firstPlan?.latest?.estimatedDurationText).toBe('3h');

    // Fresh optimizer output after the device has consumed half the energy
    // does not mutate a committed plan. The plan-level snapshot and latest
    // revision both stay on the original 3h commitment.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      energyNeededKWh: 2.25,
      planningSpeedKw: 1.5,
      horizonPlan: makeHorizon([
        // Different schedule that used to trigger a replan revision.
        makeBucket(3 * HOUR_MS, 1.125),
        makeBucket(4 * HOUR_MS, 1.125),
      ]),
    })], 2 * HOUR_MS);

    const replannedPlan = recorder.getPlanForTests('dev');
    expect(replannedPlan?.latest?.revision).toBe(1);
    expect(replannedPlan?.latest?.estimatedDurationText).toBe('3h');
    expect(replannedPlan?.initialPlanningSpeedKw).toBe(1.5);
    expect(replannedPlan?.initialEstimatedDurationText).toBe('3h');
  });

  it('resets the plan-level duration snapshot when the objective changes', () => {
    // Regression for TODO 597: `objective_changed` represents a fresh plan
    // from the user's perspective (target/deadline shift). The plan-level
    // snapshot must follow the new revision so the hero meta line reflects
    // the new commitment, not the stale prior plan.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      planningSpeedKw: 1.5,
    })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.initialEstimatedDurationText).toBe('3h');

    // Target shift: 65 → 80°C grows the plan to 9 kWh @ 1.5 kW → 6h.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      targetTemperatureC: 80,
      energyNeededKWh: 9,
      planningSpeedKw: 1.5,
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 3),
        makeBucket(3 * HOUR_MS, 3),
        makeBucket(4 * HOUR_MS, 3),
      ]),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('objective_changed');
    expect(plan?.initialPlanningSpeedKw).toBe(1.5);
    expect(plan?.initialEstimatedDurationText).toBe('6h');
  });

  it('backfills the plan-level snapshot when a legacy persisted plan hits its first replan', () => {
    // Legacy persisted plans (recorded before this snapshot shipped) carry no
    // `initialPlanningSpeedKw` / `initialEstimatedDurationText`. The next
    // replan revision must backfill from the new revision so the hero meta
    // line stops falling back to the shrinking per-revision value.
    const legacyPlan: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        dev: {
          deviceId: 'dev',
          deviceName: 'Water Heater',
          objectiveKind: 'temperature',
          targetTemperatureC: 65,
          targetPercent: null,
          deadlineAtMs: 6 * HOUR_MS,
          startedAtMs: HOUR_MS,
          pending: false,
          objectiveSignature: '["temperature",65,null,21600000,"soft"]',
          original: {
            revision: 1,
            revisedAtMs: HOUR_MS,
            computedFromPricesUpTo: 5 * HOUR_MS,
            reason: 'flow_card',
            hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 }],
            energyNeededKWh: 1.5,
            planStatus: 'on_track',
          },
          latest: {
            revision: 1,
            revisedAtMs: HOUR_MS,
            computedFromPricesUpTo: 5 * HOUR_MS,
            reason: 'flow_card',
            hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 }],
            energyNeededKWh: 1.5,
            planStatus: 'on_track',
          },
        },
      },
    };
    const { deps } = buildPersistDeps(legacyPlan);
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);
    expect(recorder.getPlanForTests('dev')?.initialEstimatedDurationText).toBeUndefined();

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      planningSpeedKw: 2,
      energyNeededKWh: 4.5,
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(3 * HOUR_MS, 1.5),
        makeBucket(4 * HOUR_MS, 1.5),
      ]),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.revision).toBe(2);
    expect(plan?.initialPlanningSpeedKw).toBe(2);
    // 4.5 kWh / 2 kW = 2h 15m
    expect(plan?.initialEstimatedDurationText).toBe('2h 15m');
  });

  it('does not call onRevisionWritten when fresh optimization changes the committed hour count', () => {
    const events: Array<{
      deviceId: string;
      reason: string;
      allocationChanged: boolean;
      hours: number;
      energyNeededKWh: number;
      projectedFinishAtMs: number | null;
    }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => {
        events.push({
          deviceId: event.deviceId,
          reason: event.reason,
          allocationChanged: event.allocationChanged,
          hours: event.revision.hours.length,
          energyNeededKWh: event.revision.energyNeededKWh,
          projectedFinishAtMs: event.projectedFinishAtMs,
        });
      },
    });

    // First observe seeds the plan — no revision-written notification (only replans fire).
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    expect(events).toEqual([]);

    // Second observe would shrink the hour count from 3 to 2 under the old
    // mutable implementation. A committed plan ignores that optimizer churn.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.0),
      ]),
    })], 2 * HOUR_MS);

    expect(events).toHaveLength(0);
    expect(recorder.getPlanForTests('dev')?.latest?.revision).toBe(1);

    // Third observe with identical hours — no further notification.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.0),
      ]),
    })], 3 * HOUR_MS);
    expect(events).toHaveLength(0);
  });

  it('does not emit onRevisionWritten or write a new revision when only plannedKWh / energyNeededKWh shifts within the same hours', () => {
    // Regression for the active-plan recorder settings churn bug: an actively
    // charging EV reports a monotonically decreasing `energyNeededKWh` every
    // ~30s plan cycle. Persisting that drift across an unchanged schedule
    // wrote `DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING` every cycle, which is
    // wasted Homey settings I/O — the user-visible plan (set of charging
    // hours) hasn't changed.
    const events: Array<{ deviceId: string; reason: string }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => {
        events.push({ deviceId: event.deviceId, reason: event.reason });
      },
    });

    // Seed at nowMs=1h with [2h, 3h, 4h] at 1.5 kWh each (energyNeededKWh=4.5).
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    expect(events).toEqual([]);
    expect(recorder.getPlanForTests('dev')?.latest?.energyNeededKWh).toBe(4.5);
    expect(recorder.getPlanForTests('dev')?.latest?.revision).toBe(1);

    // Same startsAtMs, same planStatus, lower plannedKWh / energyNeededKWh —
    // a pure consumption decrement that does not change the user-visible
    // schedule. Must not emit `onRevisionWritten` and must not bump the
    // revision counter. The previous revision metadata is retained.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      energyNeededKWh: 3.6,
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 1.2),
        makeBucket(3 * HOUR_MS, 1.2),
        makeBucket(4 * HOUR_MS, 1.2),
      ]),
    })], HOUR_MS);

    expect(events).toEqual([]);
    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.revision).toBe(1);
    expect(plan?.latest?.reason).toBe('flow_card');
    expect(plan?.latest?.energyNeededKWh).toBe(4.5);
    expect(plan?.latest?.hours).toEqual([
      { startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 3 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 4 * HOUR_MS, plannedKWh: 1.5 },
    ]);
  });

  it('persists exactly once across many EV charge cycles when schedule and status are stable', () => {
    // Regression for the active-plan recorder settings churn bug: simulates a
    // multi-cycle EV charge where the schedule and status stay constant but
    // `energyNeededKWh` decreases monotonically every cycle. Only the seed
    // cycle should call `save`; subsequent cycles must be no-ops.
    const { deps, saveCount } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    const HOURS = [2 * HOUR_MS, 3 * HOUR_MS, 4 * HOUR_MS] as const;
    const seedDiag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
    recorder.observe([seedDiag], HOUR_MS);
    recorder.flushIfDirty();
    expect(saveCount()).toBe(1);

    // 30 cycles with the same schedule and status, decreasing energyNeededKWh.
    for (let i = 1; i <= 30; i += 1) {
      const remainingKWh = 4.5 - i * 0.05;
      const perHour = remainingKWh / HOURS.length;
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        energyNeededKWh: remainingKWh,
        horizonPlan: makeHorizon(HOURS.map((startMs) => makeBucket(startMs, perHour))),
      })], HOUR_MS + i * 30 * 1000);
      recorder.flushIfDirty();
    }

    expect(saveCount()).toBe(1);
  });

  it('writes a new revision when planStatus transitions across the same set of hours', () => {
    // planStatus transitions (on_track <-> at_risk <-> cannot_meet) drive a
    // user-visible "Can't fully meet" chip in Settings UI, so they must
    // persist even when the hour set is unchanged.
    const { deps, saveCount } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.flushIfDirty();
    expect(saveCount()).toBe(1);

    // Same schedule, status flips on_track -> at_risk.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'at_risk',
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(3 * HOUR_MS, 1.5),
        makeBucket(4 * HOUR_MS, 1.5),
      ], { status: 'at_risk' }),
    })], 2 * HOUR_MS);
    recorder.flushIfDirty();

    expect(saveCount()).toBe(2);
    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.planStatus).toBe('at_risk');
    expect(plan?.latest?.revision).toBe(2);
  });

  it('skips both the revision and the bus when nothing observable changed', () => {
    const events: Array<{ reason: string }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => { events.push({ reason: event.reason }); },
    });

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    const firstRevision = recorder.getPlanForTests('dev')?.latest?.revision;
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], 2 * HOUR_MS);

    expect(events).toEqual([]);
    expect(recorder.getPlanForTests('dev')?.latest?.revision).toBe(firstRevision);
  });

  it('keeps the committed hour count through optimizer hour-count churn', () => {
    const events: Array<{ reason: string; hours: number }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => {
        events.push({
          reason: event.reason,
          hours: event.revision.hours.length,
        });
      },
    });

    // Seed at nowMs=1h with three planned hours [2h, 3h, 4h]. No event.
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);

    // Replan at nowMs=2h shrinks future allocation to [4h, 5h] (count 3 → 2
    // fires the trigger).
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(4 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 2 * HOUR_MS);

    // Replan at nowMs=4h shrinks to a single remaining hour [5h] — the
    // emitted hour count must drop with the schedule, not stay latched at
    // its peak.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 4 * HOUR_MS);

    expect(events).toEqual([]);
    expect(recorder.getPlanForTests('dev')?.latest?.hours).toEqual([
      { startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 3 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 4 * HOUR_MS, plannedKWh: 1.5 },
    ]);
  });

  it('does not emit onRevisionWritten when the set of charging hours swaps within the same count', () => {
    // The replanner can pick a different set of cheap hours of the same width
    // (e.g. price ranking shuffles equally-cheap slots). Once a plan is
    // committed, the active record ignores the reshuffle entirely.
    const events: Array<{ reason: string }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => { events.push({ reason: event.reason }); },
    });

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      // Same count (3), entirely different startsAtMs.
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 2 * HOUR_MS);

    expect(events).toEqual([]);
    expect(recorder.getPlanForTests('dev')?.latest?.revision).toBe(1);
  });

  it('does not emit onRevisionWritten when the schedule empties because the objective was satisfied', () => {
    // Once the device reaches its target the horizon plan reports zero
    // remaining energy and the planned buckets all carry 0 useful kWh,
    // collapsing the schedule to []. Firing here would produce a malformed
    // "…reach goal at . 0 kWh remaining" notification (no projected finish,
    // no remaining energy), so the bus stays quiet.
    const events: Array<{ reason: string }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => { events.push({ reason: event.reason }); },
    });

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'satisfied',
      reasonCode: 'energy_already_met',
      energyNeededKWh: 0,
      horizonPlan: makeHorizon([], {
        status: 'satisfied',
        statusDetail: 'energy_already_met',
        energyNeededKWh: 0,
        plannedUsefulEnergyKWh: 0,
      }),
    })], 2 * HOUR_MS);

    expect(events).toEqual([]);
    // Revision is still persisted so the Settings UI reflects the satisfied
    // state — the suppression is for the notification path only.
    expect(recorder.getPlanForTests('dev')?.latest?.revision).toBe(2);
    expect(recorder.getPlanForTests('dev')?.latest?.energyNeededKWh).toBe(0);
  });

  it('emits onRevisionWritten when the schedule collapses to empty because the plan cannot meet the deadline', () => {
    // Regression for the gap Codex flagged on PR #730: a planner transition
    // like `cannot_meet/target_cannot_be_met` (with partial buckets) →
    // `cannot_meet/no_bucket_capacity` (no buckets) stays within the same
    // `cannot_meet` status, so `deadline_status_changed` does not fire. The
    // `deadline_plan_changed` trigger must therefore still emit on collapses
    // backed by a degraded plan status, even though the `projectedFinishAtMs`
    // token will be empty in that case. Satisfied collapses remain suppressed
    // (see the satisfied test) because the target is met — there is no plan
    // to talk about and the notification template would render badly.
    const events: Array<{ reason: string; hours: number; planStatus: string }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => {
        events.push({
          reason: event.reason,
          hours: event.revision.hours.length,
          planStatus: event.revision.planStatus,
        });
      },
    });

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'cannot_meet',
      reasonCode: 'no_bucket_capacity',
      energyNeededKWh: 4.5,
      horizonPlan: makeHorizon([], {
        status: 'cannot_meet',
        statusDetail: 'no_bucket_capacity',
        energyNeededKWh: 4.5,
        plannedUsefulEnergyKWh: 0,
      }),
    })], 2 * HOUR_MS);

    // The committed schedule does not collapse, so the plan-changed bus stays
    // quiet. A metadata revision still persists the degraded status.
    expect(events).toEqual([]);
    expect(recorder.getPlanForTests('dev')?.latest?.revision).toBe(2);
    expect(recorder.getPlanForTests('dev')?.latest?.energyNeededKWh).toBe(4.5);
    expect(recorder.getPlanForTests('dev')?.latest?.planStatus).toBe('cannot_meet');
    expect(recorder.getPlanForTests('dev')?.latest?.hours).toHaveLength(3);
  });

  it('does not emit a prices_revised revision when a committed plan sees a later price horizon', () => {
    // The fresh schedule's last bucket extends further into the future after
    // the second observe. That used to rewrite the active plan; committed
    // schedules keep the original hours instead.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      // Same target and deadline, different cheap-hour selection — and the
      // horizon's last bucket sits later than before (5h vs 4h start), so
      // `computedFromPricesUpTo` advances.
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('flow_card');
    expect(plan?.latest?.revision).toBe(1);
    expect(plan?.original?.revision).toBe(1);
  });

  it('emits a schedule_revised revision when metadata drifts within an unchanged price horizon', () => {
    // Same horizon end across revisions and same set of charging hours — only
    // `dailyBudgetExhaustedBucketCount` flipped (the planner observed budget
    // pressure mid-day). `prices_revised` would mis-label this as
    // "Tomorrow's prices published"; the recorder now emits
    // `schedule_revised` instead. This is the per-cycle replan pattern
    // reported 2026-05-18 as firing "several times per hour".
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      dailyBudgetExhaustedBucketCount: 0,
    })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      // Same horizon, same charging hours — only the daily-budget signal
      // shifted. Triggers a metadata-only revision write.
      dailyBudgetExhaustedBucketCount: 2,
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('schedule_revised');
    expect(plan?.latest?.revision).toBe(2);
  });

  it('emits a rate_refined revision when the kwhPerUnit source flips bootstrap → learned', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // First observe: planner used the bootstrap fallback (no learned profile yet).
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: 'bootstrap',
    })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.latest?.kwhPerUnitSource).toBe('bootstrap');

    // Second observe: profile lands. Allocation shifts (different kWh/unit), and
    // the user-meaningful reason is the rate refinement — not prices.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: 'learned',
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 0.5),
        makeBucket(3 * HOUR_MS, 0.5),
        makeBucket(4 * HOUR_MS, 0.5),
      ]),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('rate_refined');
    expect(plan?.latest?.kwhPerUnitSource).toBe('learned');
    expect(plan?.latest?.revision).toBe(2);
  });

  it('does not revise when source is unchanged across a committed-plan price shift', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: 'learned',
    })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: 'learned',
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 2 * HOUR_MS);

    expect(recorder.getPlanForTests('dev')?.latest?.reason).toBe('flow_card');
    expect(recorder.getPlanForTests('dev')?.latest?.revision).toBe(1);
  });

  it('does not emit rate_refined for the learned → bootstrap regression (rare profile loss)', () => {
    // Profile loss is unusual but possible (retention prune, kind change). Treat
    // it as a plain prices_revised: there's no "refinement" to report.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: 'learned',
    })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: 'bootstrap',
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 2 * HOUR_MS);

    expect(recorder.getPlanForTests('dev')?.latest?.reason).toBe('prices_revised');
  });

  it('does not fire rate_refined when a bootstrap plan becomes satisfied (null source)', () => {
    // Regression for PR #708 review: when the EV crosses the target SoC
    // during a bootstrap-planned cycle, the diagnostic's
    // `kwhPerUnitSource` is null (resolver short-circuits energy resolution
    // because the target is already met). Coalescing that null into 'learned'
    // and treating it as `bootstrap → learned` would persist a misleading
    // `rate_refined` revision even though nothing was learned. The recorder
    // must instead treat null as "no source consulted" and label the
    // allocation-change revision `schedule_revised` (no fresher prices
    // arrived — the horizon collapsed to empty as the objective was met).
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: 'bootstrap',
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(3 * HOUR_MS, 1.5),
        makeBucket(4 * HOUR_MS, 1.5),
      ]),
    })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.latest?.kwhPerUnitSource).toBe('bootstrap');

    // Satisfied diagnostic: horizon plan has no buckets, source is null.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: null,
      status: 'satisfied',
      reasonCode: 'energy_already_met',
      energyNeededKWh: 0,
      horizonPlan: makeHorizon([], { status: 'satisfied', statusDetail: 'energy_already_met', energyNeededKWh: 0, plannedUsefulEnergyKWh: 0 }),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('schedule_revised');
    expect(plan?.latest?.kwhPerUnitSource).toBeUndefined();
    expect(plan?.latest?.revision).toBe(2);
  });

  it('persists dailyBudgetExhaustedBucketCount only when the diagnostic flagged exhaustion', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      dailyBudgetExhaustedBucketCount: 0,
    })], HOUR_MS);
    recorder.flushIfDirty();
    const onTrack = saved()!.plansByDeviceId.dev;
    expect(onTrack.latest?.dailyBudgetExhaustedBucketCount).toBeUndefined();

    // Simulate the cycle where the daily budget plateaus mid-horizon: the
    // count rises from 0 to 3, the planner now reports cannot_meet, and the
    // recorder must persist the count so the UI can explain it.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'cannot_meet',
      reasonCode: 'target_cannot_be_met',
      dailyBudgetExhaustedBucketCount: 3,
      horizonPlan: makeHorizon([], {
        status: 'cannot_meet',
        statusDetail: 'target_cannot_be_met',
        plannedUsefulEnergyKWh: 0,
        unplannedUsefulEnergyKWh: 4.5,
      }),
    })], 2 * HOUR_MS);
    recorder.flushIfDirty();
    const exhausted = saved()!.plansByDeviceId.dev;
    expect(exhausted.latest?.planStatus).toBe('cannot_meet');
    expect(exhausted.latest?.dailyBudgetExhaustedBucketCount).toBe(3);
    expect(exhausted.latest?.revision).toBe(2);
  });

  it('writes a schedule_revised revision when source flips learned→bootstrap even with identical hours', () => {
    // Regression for PR #708 review: if the profile is pruned (or the device
    // is removed/re-added) and the bucket allocation happens to be
    // byte-identical across the source flip, the recorder must still write a
    // revision so persisted `kwhPerUnitSource` does not stay stale at
    // 'learned' while the planner is using bootstrap. Since the price
    // horizon is unchanged (identical buckets), the reason is
    // `schedule_revised` — not `prices_revised`, which would imply a
    // publication event.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    const sharedPlan = makeHorizon([
      makeBucket(2 * HOUR_MS, 1.5),
      makeBucket(3 * HOUR_MS, 1.5),
      makeBucket(4 * HOUR_MS, 1.5),
    ]);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: 'learned',
      horizonPlan: sharedPlan,
    })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.latest?.kwhPerUnitSource).toBe('learned');

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      kwhPerUnitSource: 'bootstrap',
      horizonPlan: sharedPlan,
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('schedule_revised');
    expect(plan?.latest?.kwhPerUnitSource).toBe('bootstrap');
    expect(plan?.latest?.revision).toBe(2);
  });

  it('drops the record once the deadline passes', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([], 7 * HOUR_MS);
    recorder.flushIfDirty();

    expect(saved()!.plansByDeviceId.dev).toBeUndefined();
  });

  it('keeps the record across a single empty diagnostic cycle (transient SDK miss)', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    // One empty cycle simulates a transient Homey settings read returning empty.
    recorder.observe([], HOUR_MS + 60 * 1000);

    expect(recorder.getPlanForTests('dev')).toBeDefined();
  });

  it('drops the record once the abandon-grace window elapses without the diagnostic', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 10 * HOUR_MS })], HOUR_MS);
    // 1h ABANDON_GRACE_MS — at exactly 1h after last seen, drop fires.
    recorder.observe([], 2 * HOUR_MS);
    recorder.flushIfDirty();

    expect(saved()!.plansByDeviceId.dev).toBeUndefined();
  });

  it('clearForDevice removes the record (clear_deadline flow card)', () => {
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.markPending(buildSeed(), 0);
    recorder.clearForDevice('dev');
    recorder.flushIfDirty();

    expect(saved()!.plansByDeviceId.dev).toBeUndefined();
  });

  it('starts a new pending plan when markPending receives a different target for an already committed plan', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // 1. Establish an active plan for target 65 °C.
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.latest?.reason).toBe('flow_card');

    // 2. User edits the target via the flow card. A committed plan is not
    // revised in place; the old active record is abandoned and replaced by a
    // fresh pending entry for the new objective.
    recorder.markPending(buildSeed({ targetTemperatureC: 70 }), 2 * HOUR_MS);

    const pending = recorder.getPlanForTests('dev');
    expect(pending?.pending).toBe(true);
    expect(pending?.original).toBeNull();
    expect(pending?.latest).toBeNull();
    expect(pending?.targetTemperatureC).toBe(70);
    expect(pending?.startedAtMs).toBe(2 * HOUR_MS);

    // 3. The next plan cycle observes a diagnostic with the new target and
    // writes a new first revision, not `objective_changed` revision 2.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      targetTemperatureC: 70,
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 2.0),
        makeBucket(3 * HOUR_MS, 2.0),
        makeBucket(4 * HOUR_MS, 2.0),
      ]),
    })], 3 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('prices_arrived');
    expect(plan?.latest?.revision).toBe(1);
    expect(plan?.objectiveSignature).toContain('70');
  });

  it('aggregates trimmed current-bucket segments into the containing hour', () => {
    // Regression: the horizon planner trims the current bucket's start to nowMs
    // and may split a single hour into two segments at planningEndMs. Persist
    // each segment under the floor-of-hour timestamp and sum the energy so the
    // Settings UI can find the planned kWh by the price-horizon hour key.
    // See PR #643 review thread 5.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);
    const hourStart = 2 * HOUR_MS;
    const midHour = hourStart + 23 * 60 * 1000;
    const splitMid = hourStart + 40 * 60 * 1000;

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        // Segment 1: trimmed start (mid-hour) up to the planningEndMs split.
        makeBucket(midHour, 0.4, { endMs: splitMid }),
        // Segment 2: post-split, still inside the same hour.
        makeBucket(splitMid, 0.6, { endMs: hourStart + HOUR_MS }),
        // Next full hour, normal start.
        makeBucket(3 * HOUR_MS, 1.5),
      ]),
    })], midHour);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.hours).toEqual([
      { startsAtMs: hourStart, plannedKWh: 1.0 },
      { startsAtMs: 3 * HOUR_MS, plannedKWh: 1.5 },
    ]);
  });

  it('survives reload by restoring plans from persisted state', () => {
    const persisted: DeferredObjectiveActivePlansV1 = {
      version: 1,
      plansByDeviceId: {
        dev: {
          deviceId: 'dev',
          deviceName: 'Water Heater',
          objectiveKind: 'temperature',
          targetTemperatureC: 65,
          targetPercent: null,
          deadlineAtMs: 6 * HOUR_MS,
          startedAtMs: 0,
          pending: false,
          objectiveSignature: '["temperature",65,null,21600000,"soft"]',
          original: {
            revision: 1,
            revisedAtMs: HOUR_MS,
            computedFromPricesUpTo: 5 * HOUR_MS,
            reason: 'flow_card',
            hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 }],
          },
          latest: {
            revision: 1,
            revisedAtMs: HOUR_MS,
            computedFromPricesUpTo: 5 * HOUR_MS,
            reason: 'flow_card',
            hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 }],
          },
        },
      },
    };
    const { deps } = buildPersistDeps(persisted);
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);
    expect(recorder.getActivePlansSnapshot().plansByDeviceId.dev?.latest?.revision).toBe(1);
  });

  describe('normalizeDeferredObjectiveActivePlans (persisted-plan round trip)', () => {
    const baseRevision = {
      revision: 1,
      revisedAtMs: HOUR_MS,
      computedFromPricesUpTo: 6 * HOUR_MS,
      hours: [{ startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 }],
      energyNeededKWh: 1.5,
      planStatus: 'on_track' as const,
    };
    const basePlan = (
      revisionOverrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      deviceId: 'dev',
      deviceName: 'Garage EV',
      objectiveKind: 'ev_soc',
      targetTemperatureC: null,
      targetPercent: 60,
      deadlineAtMs: 6 * HOUR_MS,
      startedAtMs: HOUR_MS,
      pending: false,
      objectiveSignature: 'sig',
      original: { ...baseRevision, reason: 'flow_card', ...revisionOverrides },
      latest: { ...baseRevision, reason: 'flow_card', ...revisionOverrides },
    });

    it('preserves a rate_refined revision through the validator', () => {
      // Regression: previously the VALID_REASONS allowlist omitted 'rate_refined',
      // so any persisted plan whose latest revision had been bootstrap→learned
      // refined was silently discarded on app restart.
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: basePlan({ reason: 'rate_refined', kwhPerUnitSource: 'learned' }),
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev?.latest?.reason).toBe('rate_refined');
      expect(normalized.plansByDeviceId.dev?.latest?.kwhPerUnitSource).toBe('learned');
    });

    it('preserves a schedule_revised revision through the validator', () => {
      // Regression: the v2.7.3 fix introduced `schedule_revised` as the
      // catch-all reason for internal replans. The persisted-plan validator
      // must accept it; otherwise restarts silently drop revisions that the
      // recorder is now emitting in the most common code path.
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: basePlan({ reason: 'schedule_revised' }),
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev?.latest?.reason).toBe('schedule_revised');
    });

    it('preserves a bootstrap-source revision', () => {
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: basePlan({ reason: 'flow_card', kwhPerUnitSource: 'bootstrap' }),
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev?.latest?.kwhPerUnitSource).toBe('bootstrap');
    });

    it('accepts legacy revisions without a kwhPerUnitSource field', () => {
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: basePlan({ reason: 'prices_revised' }),
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev?.latest?.reason).toBe('prices_revised');
      expect(normalized.plansByDeviceId.dev?.latest?.kwhPerUnitSource).toBeUndefined();
    });

    it('drops plans whose kwhPerUnitSource is present but malformed', () => {
      // Defensive: a corrupt persisted value should not bleed an unknown source
      // value into downstream typed code.
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: basePlan({ reason: 'flow_card', kwhPerUnitSource: 'totally_invalid' }),
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev).toBeUndefined();
    });

    it('round-trips initialPlanningSpeedKw + initialEstimatedDurationText on the plan', () => {
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: {
            ...basePlan({ reason: 'flow_card' }),
            initialPlanningSpeedKw: 1.5,
            initialEstimatedDurationText: '3h',
          },
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev?.initialPlanningSpeedKw).toBe(1.5);
      expect(normalized.plansByDeviceId.dev?.initialEstimatedDurationText).toBe('3h');
    });

    it('round-trips a committed schedule on the plan', () => {
      const commitment = {
        committedAtMs: HOUR_MS,
        hours: [
          { startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 },
          { startsAtMs: 3 * HOUR_MS, plannedKWh: 1.5 },
        ],
      };
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: {
            ...basePlan({ reason: 'flow_card' }),
            commitment,
          },
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev?.commitment).toEqual(commitment);
    });

    it('drops a plan whose initialPlanningSpeedKw is non-positive', () => {
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: {
            ...basePlan({ reason: 'flow_card' }),
            initialPlanningSpeedKw: 0,
          },
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev).toBeUndefined();
    });
  });
});
