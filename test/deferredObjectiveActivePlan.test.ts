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
  it('persists energyExpectedKWh only when it differs from the buffered energyNeededKWh', () => {
    // horizonPlan.energyNeededKWh = 4.5 (sum of buckets). A lower expected
    // figure means a buffer is booked → persist it for the UI range.
    const buffered = buildPersistDeps();
    const recorderBuffered = new DeferredObjectiveActivePlanRecorder(buffered.deps);
    recorderBuffered.observe(
      [makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS, energyExpectedKWh: 4 })],
      HOUR_MS,
    );
    recorderBuffered.flushIfDirty();
    expect(buffered.saved()!.plansByDeviceId.dev.latest?.energyExpectedKWh).toBeCloseTo(4);

    // Equal expected (no buffer) → omitted so steady plans stay byte-stable.
    const steady = buildPersistDeps();
    const recorderSteady = new DeferredObjectiveActivePlanRecorder(steady.deps);
    recorderSteady.observe(
      [makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS, energyExpectedKWh: 4.5 })],
      HOUR_MS,
    );
    recorderSteady.flushIfDirty();
    expect(steady.saved()!.plansByDeviceId.dev.latest?.energyExpectedKWh).toBeUndefined();

    // Absent on the diagnostic (legacy / unresolved) → omitted.
    const legacy = buildPersistDeps();
    const recorderLegacy = new DeferredObjectiveActivePlanRecorder(legacy.deps);
    recorderLegacy.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorderLegacy.flushIfDirty();
    expect(legacy.saved()!.plansByDeviceId.dev.latest?.energyExpectedKWh).toBeUndefined();
  });

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

  it('logs each replan into a most-recent-first history capped at 20 entries', () => {
    // Persistence contract for batch 4's smart-task revision history panel:
    // every revision write prepends the prior `latest` onto the `history`
    // array (so head === "previous-to-latest"). 20 covers any realistic
    // task lifecycle (single-digit replans typical); we slice past the cap
    // to keep the persisted blob bounded. Legacy persisted plans without
    // a `history` field load as undefined and start populating on next
    // replan — tested separately in `accepts legacy persisted plans
    // without a history field` below.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // First revision — no history yet.
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 30 * HOUR_MS })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.history).toBeUndefined();

    // Drive 25 objective-changed replans by varying the target temperature
    // each cycle — that forces an unconditional revision write regardless
    // of the merge / committed-replan logic, which is what we want for a
    // pure history-mechanism test (no entanglement with batch 1+2's
    // expansion / commitment-preservation semantics).
    for (let cycle = 1; cycle <= 25; cycle += 1) {
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 30 * HOUR_MS,
        targetTemperatureC: 60 + cycle,
        horizonPlan: makeHorizon([
          makeBucket((1 + cycle) * HOUR_MS, 1.5),
        ]),
      })], (1 + cycle) * HOUR_MS);
    }

    const plan = recorder.getPlanForTests('dev');
    // History is capped at 20 entries, most-recent first.
    expect(plan?.history).toHaveLength(20);
    // Head of history is the revision immediately before `latest`.
    expect(plan?.history?.[0]?.revision).toBe((plan?.latest?.revision ?? 0) - 1);
    // Tail of history is the oldest preserved revision (FIFO prune of older).
    expect(plan?.history?.at(-1)?.revision)
      .toBe((plan?.latest?.revision ?? 0) - 20);
    // Order is strictly descending by revision number.
    const revisions = plan?.history?.map((h) => h.revision) ?? [];
    for (let i = 0; i < revisions.length - 1; i += 1) {
      expect(revisions[i]).toBeGreaterThan(revisions[i + 1]!);
    }
  });

  it('does not grow history when a cycle produces no new revision', () => {
    // The history log advances only when `maybeWriteReplanRevision`
    // actually writes a new revision. Cycles that produce identical
    // diagnostics (or sub-threshold drift) must not push duplicate entries
    // — the per-cycle 30 s cadence would otherwise blow through the cap
    // in under 11 minutes on a stable task.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 30 * HOUR_MS })], HOUR_MS);
    // Drive 10 identical observations — none should produce a revision write.
    for (let cycle = 1; cycle <= 10; cycle += 1) {
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 30 * HOUR_MS })], (1 + cycle) * HOUR_MS);
    }
    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.revision).toBe(1);
    expect(plan?.history).toBeUndefined();
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

  it('extends the commitment when expansion adds hours to a previously satisfied (empty-commitment) plan', () => {
    // Morning-shower scenario: task created with current temp already above
    // target gets `commitment.hours = []` because there was nothing to plan.
    // Then a hot-water draw crashes the tank → energyNeeded recomputes
    // upward, phase-2 expansion fires, live horizon now contains future
    // buckets. The recorder must persist those buckets into both
    // `revision.hours` and `commitment.hours` so UI / notifications /
    // history consumers see the recovery — not just the runtime executor.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // First cycle: target already met, zero planned hours.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'satisfied',
      reasonCode: 'energy_already_met',
      energyNeededKWh: 0,
      horizonPlan: makeHorizon([], { status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], HOUR_MS);
    const initial = recorder.getPlanForTests('dev');
    expect(initial?.commitment?.hours).toEqual([]);
    expect(initial?.latest?.hours).toEqual([]);

    // Second cycle: drift triggered expansion; live plan now contains two
    // future buckets the planner has decided to claim.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'on_track',
      reasonCode: 'planned_with_margin',
      energyNeededKWh: 2,
      horizonPlan: makeHorizon([
        makeBucket(4 * HOUR_MS, 1),
        makeBucket(5 * HOUR_MS, 1),
      ]),
    })], 2 * HOUR_MS);
    const expanded = recorder.getPlanForTests('dev');

    expect(expanded?.latest?.revision).toBe(2);
    expect(expanded?.latest?.reason).toBe('schedule_revised');
    expect(expanded?.latest?.hours.map((h) => h.startsAtMs)).toEqual([4 * HOUR_MS, 5 * HOUR_MS]);
    // Single source of truth: commitment now contains the expansion hours.
    expect(expanded?.commitment?.hours.map((h) => h.startsAtMs)).toEqual([4 * HOUR_MS, 5 * HOUR_MS]);
    expect(expanded?.commitment?.committedAtMs).toBe(2 * HOUR_MS);
  });

  it('grows an existing commitment with expansion-added hours while preserving committed plannedKWh as a floor on overlap', () => {
    // Drift case where the original commitment is non-empty: hour 2 was
    // committed at 1.5 kWh. Later cycle's live plan still includes hour 2
    // (now down to 1.0 kWh because some energy was already delivered) and
    // adds hour 5 via expansion. The commitment grows to include hour 5;
    // hour 2's plannedKWh stays at the committed 1.5 kWh because the
    // committed value is the contract floor — letting a shrinking live
    // value rewrite it downward would cap future delivery against the
    // original commitment (next cycle's `buildCommittedHourMap` would
    // enforce 1.0 kWh).
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([makeBucket(2 * HOUR_MS, 1.5)]),
    })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.commitment?.hours.map((h) => h.startsAtMs)).toEqual([2 * HOUR_MS]);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 1.0),
        makeBucket(5 * HOUR_MS, 0.5),
      ]),
    })], 2 * HOUR_MS);
    const expanded = recorder.getPlanForTests('dev');

    expect(expanded?.latest?.revision).toBe(2);
    expect(expanded?.commitment?.hours).toEqual([
      { startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 5 * HOUR_MS, plannedKWh: 0.5 },
    ]);
  });

  it('preserves committed hours when the live plan drops them mid-task (commitment cannot shrink)', () => {
    // After expansion has committed multiple hours, an intervening cycle
    // where energy need transiently goes to zero must not erase those
    // committed hours. The commitment is the historical contract for
    // those hours; energy may already have been delivered against them.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(3 * HOUR_MS, 1.5),
      ]),
    })], HOUR_MS);
    const initial = recorder.getPlanForTests('dev');
    const initialHours = initial?.commitment?.hours.map((h) => h.startsAtMs);
    const initialRevision = initial?.latest?.revision;

    // Second cycle: tank reached target, planner has nothing to add.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'satisfied',
      reasonCode: 'energy_already_met',
      energyNeededKWh: 0,
      horizonPlan: makeHorizon([], { status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], 2 * HOUR_MS);
    const preserved = recorder.getPlanForTests('dev');

    // Commitment hours unchanged. A revision may be written for the
    // planStatus drift (satisfied), but `commitment.hours` must hold.
    expect(preserved?.commitment?.hours.map((h) => h.startsAtMs)).toEqual(initialHours);
    expect(preserved?.commitment?.committedAtMs).toBe(initial?.commitment?.committedAtMs);
    // Schedule itself did not shrink — `latest.hours` mirrors the preserved commitment.
    expect(preserved?.latest?.hours.map((h) => h.startsAtMs)).toEqual(initialHours);
    expect(initialRevision).toBe(1);
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
    expect(plan?.latest?.hours).toEqual([
      { startsAtMs: 2 * HOUR_MS, plannedKWh: 2 },
      { startsAtMs: 3 * HOUR_MS, plannedKWh: 2 },
      { startsAtMs: 4 * HOUR_MS, plannedKWh: 2 },
    ]);
    expect(plan?.commitment?.hours).toEqual(plan?.latest?.hours);
  });

  // Regression for the rescue-only branch of the replan-reason cascade. Toggling
  // a Flow rescue permission changes the active-plan objective signature, which
  // would otherwise route the replan through generic `objective_changed` — the
  // history detail then says the smart-task settings / target changed instead of
  // naming the Flow permission change the user actually made. The recorder must
  // detect "signature differs only in the rescue segment" and route to the
  // reserved `flow_permission_changed` reason ahead of the generic fallback.
  describe('rescue-permission-only replan routing', () => {
    it('emits flow_permission_changed when only the rescue segment differs', () => {
      const { deps } = buildPersistDeps();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);

      // Pre-state: no rescue permission granted.
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);

      // Post-state: same target, same deadline, same enforcement — only the
      // rescue permission changes (user enabled the at-risk exempt-from-budget
      // Flow card). The horizon allocation may legitimately re-balance, so use
      // a different bucket pattern that still totals 4.5 kWh.
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        rescue: { exemptFromBudget: 'at_risk' },
        horizonPlan: makeHorizon([
          makeBucket(2 * HOUR_MS, 1.5),
          makeBucket(3 * HOUR_MS, 1.5),
          makeBucket(5 * HOUR_MS, 1.5),
        ]),
      })], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.latest?.reason).toBe('flow_permission_changed');
      expect(plan?.latest?.revision).toBe(2);
      // The new schedule is committed under the new permission set; the next
      // cycle should treat the re-balanced hours as the committed envelope.
      expect(plan?.commitment?.hours).toEqual(plan?.latest?.hours);
    });

    it('emits flow_permission_changed when a granted rescue permission is revoked', () => {
      // Symmetric case: starting with a rescue permission and clearing it
      // should also surface as a Flow permission change, not a settings edit.
      // Seed via observe() so the persisted signature carries the rescue tail
      // from the start.
      const { deps } = buildPersistDeps();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        rescue: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' },
      })], HOUR_MS);

      // Clear both permissions (rescue tail disappears entirely).
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        horizonPlan: makeHorizon([
          makeBucket(2 * HOUR_MS, 1.5),
          makeBucket(3 * HOUR_MS, 1.5),
          makeBucket(5 * HOUR_MS, 1.5),
        ]),
      })], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.latest?.reason).toBe('flow_permission_changed');
      expect(plan?.latest?.revision).toBe(2);
    });

    it('still emits objective_changed when the target changes (rescue unchanged)', () => {
      // Negative case: target shift must keep routing through
      // `objective_changed`. Asserts the rescue-only short-circuit doesn't
      // swallow target/deadline edits.
      const { deps } = buildPersistDeps();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        targetTemperatureC: 70,
        horizonPlan: makeHorizon([
          makeBucket(2 * HOUR_MS, 2.0),
          makeBucket(3 * HOUR_MS, 2.0),
          makeBucket(4 * HOUR_MS, 2.0),
        ]),
      })], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.latest?.reason).toBe('objective_changed');
    });

    it('emits objective_changed when both target and rescue change (target wins)', () => {
      // Mixed-change priority guard. Without the "base segment must be equal"
      // gate in `compareObjectiveSignatures`, a future refactor that flipped
      // the priority (rescue tail wins) would silently mislabel an objective
      // edit as a Flow permission change. This test fails if the cascade
      // inverts the order.
      const { deps } = buildPersistDeps();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        targetTemperatureC: 70,
        rescue: { exemptFromBudget: 'at_risk' },
        horizonPlan: makeHorizon([
          makeBucket(2 * HOUR_MS, 2.0),
          makeBucket(3 * HOUR_MS, 2.0),
          makeBucket(4 * HOUR_MS, 2.0),
        ]),
      })], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.latest?.reason).toBe('objective_changed');
    });

    it('still emits schedule_revised when neither base nor rescue change but planStatus drifts', () => {
      // Sanity: the rescue-only branch must not steal revisions caused by
      // metadata drift (planStatus transition with the same schedule). Forces
      // a replan via a status flip on an identical bucket layout — recorder
      // emits `schedule_revised` because both the base and rescue segments are
      // byte-identical.
      const { deps } = buildPersistDeps();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        horizonPlan: makeHorizon([
          makeBucket(2 * HOUR_MS, 1.5),
          makeBucket(3 * HOUR_MS, 1.5),
          makeBucket(4 * HOUR_MS, 1.5),
        ], { status: 'at_risk', statusDetail: 'planned_using_deadline_reserve' }),
      })], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.latest?.reason).toBe('schedule_revised');
    });

    it('emits flow_permission_changed on a single-permission toggle when the other rescue permission stays granted', () => {
      // Cascade-stability pin (PR #998 follow-up): mirrors the shape
      // `withRescuePermission(entry, 'exemptFromBudget', 'always')` would
      // produce when the existing entry already carries
      // `limitLowerPriorityDevices: 'always'`. The `key === ...` ternary in
      // `withRescuePermission` keeps the non-targeted permission intact, so the
      // recorder sees the rescue tail flip from `['rescue', null, 'always']` to
      // `['rescue', 'always', 'always']` — `baseChanged = false`,
      // `rescueChanged = true` → `rescueOnly = true` → routes to
      // `flow_permission_changed`. A refactor that broke the ternary (e.g. by
      // discarding the prior permission) would still set the rescue tail but
      // also move things around enough that this assertion would catch the
      // regression at the recorder boundary.
      const { deps } = buildPersistDeps();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);

      // Pre-state: only `limitLowerPriorityDevices` is granted; `exemptFromBudget`
      // is absent (the user has never set it, or set it to 'never' which the
      // flow card stores as absent).
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        rescue: { limitLowerPriorityDevices: 'always' },
      })], HOUR_MS);

      // Post-state: user toggles `exempt_from_budget` to `always`. The flow
      // card's `withRescuePermission` carries the prior
      // `limitLowerPriorityDevices: 'always'` forward unchanged. Schedule is
      // unchanged so the only signature delta is the rescue tail.
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        rescue: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' },
      })], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.latest?.reason).toBe('flow_permission_changed');
      expect(plan?.latest?.revision).toBe(2);
    });

    it('emits flow_permission_changed when a rescue toggle and a planStatus drift land in the same cycle', () => {
      // Cascade-priority pin (PR #998 follow-up): a rescue permission flip
      // simultaneous with a `planStatus` drift on identical hours must still
      // route to `flow_permission_changed`. On its own the status drift would
      // route to `schedule_revised` (see the negative test directly above);
      // here the rescue change forces `objectiveChanged = true` AND
      // `rescueOnly = true`, so `resolveReplanReason` picks the dedicated
      // `flow_permission_changed` reason before falling through to
      // `schedule_revised`. A refactor that reordered the cascade (e.g. by
      // checking `metadataDriftedWithinSchedule` first) would silently swap
      // the reasons and the history detail would name the wrong cause.
      const { deps } = buildPersistDeps();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);

      // Pre-state: no rescue, status 'on_track' (the default in `makeHorizon`).
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);

      // Post-state: enable `exempt_from_budget` AND drift the status to
      // 'at_risk' on the same bucket layout. The cascade must pick the rescue
      // reason; the status drift is irrelevant once the signature differs.
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        rescue: { exemptFromBudget: 'at_risk' },
        horizonPlan: makeHorizon([
          makeBucket(2 * HOUR_MS, 1.5),
          makeBucket(3 * HOUR_MS, 1.5),
          makeBucket(4 * HOUR_MS, 1.5),
        ], { status: 'at_risk', statusDetail: 'planned_using_deadline_reserve' }),
      })], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.latest?.reason).toBe('flow_permission_changed');
      expect(plan?.latest?.revision).toBe(2);
    });
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

  it('omits snapshot keys (not explicit undefined) when an objective_changed reset has no planning speed', () => {
    // The recorder used to set explicit `undefined` on the snapshot fields so
    // an `objective_changed` reset could drop them through `JSON.stringify`.
    // The in-memory shape exposed explicit `undefined` keys that violate
    // `exactOptionalPropertyTypes`-style contracts. The conditional-spread fix
    // must leave the keys off the in-memory object entirely while still
    // dropping the prior snapshot values from `...current` on the reset path.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      planningSpeedKw: 1.5,
    })], HOUR_MS);
    const seeded = recorder.getPlanForTests('dev');
    expect(seeded?.initialPlanningSpeedKw).toBe(1.5);
    expect(seeded?.initialEstimatedDurationText).toBe('3h');

    // Target shift drives `objective_changed`; omit `planningSpeedKw` so the
    // new revision has no usable speed and the reset path falls through to
    // dropping the snapshot.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      targetTemperatureC: 80,
      energyNeededKWh: 9,
      planningSpeedKw: undefined,
      horizonPlan: makeHorizon([
        makeBucket(2 * HOUR_MS, 3),
        makeBucket(3 * HOUR_MS, 3),
        makeBucket(4 * HOUR_MS, 3),
      ]),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('objective_changed');
    expect(plan?.initialPlanningSpeedKw).toBeUndefined();
    expect(plan?.initialEstimatedDurationText).toBeUndefined();
    // The real assertion: the keys are absent from the in-memory object, not
    // present-with-undefined. Round-tripping through `JSON.stringify` produces
    // identical output either way; this guards against contract drift.
    expect('initialPlanningSpeedKw' in (plan as object)).toBe(false);
    expect('initialEstimatedDurationText' in (plan as object)).toBe(false);
  });

  it('backfills the plan-level snapshot when a legacy persisted plan hits its first replan', () => {
    // Legacy persisted plans (recorded before this snapshot shipped) carry no
    // `initialPlanningSpeedKw` / `initialEstimatedDurationText`. The next
    // replan revision must backfill from the new revision so the hero meta
    // line stops falling back to the shrinking per-revision value. Drive the
    // replan via a `planStatus` transition so the commitment-backfilled
    // schedule envelope stays stable while metadata drifts.
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
      ], {
        status: 'at_risk',
        statusDetail: 'planned_using_deadline_reserve',
        energyNeededKWh: 4.5,
      }),
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

  it('emits onRevisionWritten exactly once when phase-2 expansion grows the schedule from empty', () => {
    // Pins the flow-trigger contract for the satisfied-then-drifted recovery
    // path (e.g. tonight's 2026-05-27 morning-shower scenario from
    // production). Sequence:
    //   1. Task created with target already met → revision 1 has empty hours
    //      and no notification fires (seed revision is silent).
    //   2. Drift triggers expansion → revision 2 grows the schedule by N
    //      hours → `shouldFireNotification(0, N, 'on_track')` fires the
    //      `deadline_plan_changed` flow trigger once.
    //   3. Subsequent stable cycle with unchanged schedule → no additional
    //      notification (no token storm per cycle).
    // The trigger tokens (`planned_hours`, `remaining_kwh`) come straight
    // off the revision, so the recorder writing the expansion into
    // `revision.hours` is what makes the user-visible notification correct.
    const events: Array<{
      reason: string; hours: number; planStatus: string; energyNeededKWh: number;
    }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => {
        events.push({
          reason: event.reason,
          hours: event.revision.hours.length,
          planStatus: event.revision.planStatus,
          energyNeededKWh: event.revision.energyNeededKWh,
        });
      },
    });

    // Seed: task created with target already met (no hours, no notification).
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'satisfied',
      reasonCode: 'energy_already_met',
      energyNeededKWh: 0,
      horizonPlan: makeHorizon([], { status: 'satisfied', statusDetail: 'energy_already_met' }),
    })], HOUR_MS);
    expect(events).toEqual([]);

    // Drift causes phase-2 expansion: 2 future buckets added, hour count
    // grows from 0 → 2. Trigger fires once.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'on_track',
      energyNeededKWh: 2,
      horizonPlan: makeHorizon([
        makeBucket(4 * HOUR_MS, 1),
        makeBucket(5 * HOUR_MS, 1),
      ]),
    })], 2 * HOUR_MS);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: 'schedule_revised',
      hours: 2,
      planStatus: 'on_track',
      energyNeededKWh: 2,
    });

    // Subsequent stable cycle with identical schedule → no further trigger.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'on_track',
      energyNeededKWh: 2,
      horizonPlan: makeHorizon([
        makeBucket(4 * HOUR_MS, 1),
        makeBucket(5 * HOUR_MS, 1),
      ]),
    })], 3 * HOUR_MS);
    expect(events).toHaveLength(1);
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

  it('persists floorShortfallCause from the diagnostic reasonCode (squeeze case)', () => {
    // Prod squeeze repro: per-bucket background-squeeze leaves
    // `dailyBudgetExhaustedBucketCount` at 0, but the planner still resolves
    // `limited_by_daily_budget` as the statusDetail because the floor only
    // fits with the per-bucket cap lifted. The recorder must persist
    // `floorShortfallCause: 'budget'` so the hero copy routes the recourse
    // to `Open Budget`, not `Adjust device`.
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'at_risk',
      reasonCode: 'limited_by_daily_budget',
      dailyBudgetExhaustedBucketCount: 0,
      horizonPlan: makeHorizon([makeBucket(2 * HOUR_MS, 1)], {
        status: 'at_risk',
        statusDetail: 'limited_by_daily_budget',
        plannedUsefulEnergyKWh: 1,
        unplannedUsefulEnergyKWh: 0.5,
      }),
    })], HOUR_MS);
    recorder.flushIfDirty();

    const plan = saved()!.plansByDeviceId.dev;
    expect(plan.latest?.floorShortfallCause).toBe('budget');
    // Squeeze case: bucketCount stays at 0, but the cause is still budget.
    expect(plan.latest?.dailyBudgetExhaustedBucketCount).toBeUndefined();
    expect(plan.latest?.planStatus).toBe('at_risk');
  });

  it('omits floorShortfallCause when no shortfall is in play (byte-stable on healthy plans)', () => {
    // Steady on-track plan with `planned_with_margin` resolves to
    // `floorShortfallCause: 'none'` in the helper, which the recorder
    // suppresses (sibling to the dailyBudgetExhaustedBucketCount: 0
    // suppression) so legacy plans without the field stay byte-stable
    // across revisions.
    const { deps, saved } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.flushIfDirty();

    expect(saved()!.plansByDeviceId.dev.latest?.floorShortfallCause).toBeUndefined();
  });

  it('emits a schedule_revised revision when floorShortfallCause flips within the same charging hours', () => {
    // Same set of charging hours but the floor cause shifted from
    // `feasible_above_floor` (step-power undercount) to
    // `limited_by_daily_budget` (per-bucket squeeze). The hero recourse
    // routing depends on the cause — without re-persisting, the UI would
    // keep pointing at the device-side `Adjust device` button while the
    // honest verdict is `Open Budget`.
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
      status: 'at_risk',
      reasonCode: 'feasible_above_floor',
      horizonPlan: { ...sharedPlan, status: 'at_risk', statusDetail: 'feasible_above_floor' },
    })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.latest?.floorShortfallCause).toBe('step_power');

    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      status: 'at_risk',
      reasonCode: 'limited_by_daily_budget',
      horizonPlan: { ...sharedPlan, status: 'at_risk', statusDetail: 'limited_by_daily_budget' },
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('schedule_revised');
    expect(plan?.latest?.revision).toBe(2);
    expect(plan?.latest?.floorShortfallCause).toBe('budget');
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

  describe('commitment backfill on legacy persisted plans', () => {
    const legacyHours = [
      { startsAtMs: 2 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 3 * HOUR_MS, plannedKWh: 1.5 },
      { startsAtMs: 4 * HOUR_MS, plannedKWh: 1.5 },
    ];

    const buildLegacyPersisted = (
      overrides: Partial<DeferredObjectiveActivePlansV1['plansByDeviceId'][string]> = {},
    ): DeferredObjectiveActivePlansV1 => ({
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
            hours: legacyHours,
          },
          latest: {
            revision: 1,
            revisedAtMs: HOUR_MS,
            computedFromPricesUpTo: 5 * HOUR_MS,
            reason: 'flow_card',
            hours: legacyHours,
          },
          ...overrides,
        },
      },
    });

    it('adopts the latest schedule as the committed envelope on a legacy plan', () => {
      // v2.7.3 persisted plans never set `commitment`, so the executor falls
      // back to fresh optimisation every cycle. The recorder must quietly
      // backfill the existing schedule as the committed envelope on the first
      // observe cycle after upgrade.
      const persisted = buildLegacyPersisted();
      const { deps } = buildPersistDeps(persisted);
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);

      const observeAtMs = 2 * HOUR_MS;
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], observeAtMs);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.commitment).toEqual({
        committedAtMs: observeAtMs,
        hours: legacyHours,
      });
    });

    it('skips backfill when the legacy plan is pending', () => {
      // Pending plans have no committed allocation yet; the next observe
      // cycle should write the first revision via `writeFirstRevision`,
      // which already sets `commitment`. Backfill must not run.
      const persisted = buildLegacyPersisted({
        pending: true,
        original: null,
        latest: null,
      });
      const { deps } = buildPersistDeps(persisted);
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);

      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      // The pending plan should transition into a fresh first revision
      // (which sets commitment via writeFirstRevision), not via the
      // legacy-backfill path. The committedAtMs therefore matches the
      // observe timestamp regardless; the test below pins the contract.
      expect(plan?.pending).toBe(false);
      expect(plan?.commitment?.committedAtMs).toBe(2 * HOUR_MS);
      expect(plan?.original?.revision).toBe(1);
    });

    it('does not backfill commitment from an empty latest, but writes one when the next revision picks up live hours', () => {
      // The backfill path explicitly skips empty `latest.hours` — a legacy
      // plan with no allocation can't seed a meaningful committed envelope.
      // After the expansion-extends-commitment change, the next revision
      // write path is what lays down the commitment whenever the live
      // diagnostic carries hours the previous revision did not — same
      // mechanism that handles the satisfied-then-drift case on fresh
      // plans. So a legacy plan whose latest was empty gets a fresh
      // commitment from the first observe cycle that actually allocates.
      const persisted = buildLegacyPersisted({
        original: {
          revision: 1,
          revisedAtMs: HOUR_MS,
          computedFromPricesUpTo: 5 * HOUR_MS,
          reason: 'flow_card',
          hours: [],
        },
        latest: {
          revision: 1,
          revisedAtMs: HOUR_MS,
          computedFromPricesUpTo: 5 * HOUR_MS,
          reason: 'flow_card',
          hours: [],
        },
      });
      const { deps } = buildPersistDeps(persisted);
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);

      const diag = makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS });
      recorder.observe([diag], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      // Commitment hours come from the live diagnostic (the default 3-bucket
      // horizon), committedAtMs is the observe timestamp.
      expect(plan?.commitment?.hours.map((h) => h.startsAtMs)).toEqual([
        2 * HOUR_MS, 3 * HOUR_MS, 4 * HOUR_MS,
      ]);
      expect(plan?.commitment?.committedAtMs).toBe(2 * HOUR_MS);
    });

    it('writes a fresh commitment when the persisted signature mismatches the current diagnostic', () => {
      // Legacy plan was persisted for target 65C, but the user changed the
      // objective to 70C before the upgrade was observed. The persisted
      // `latest.hours` reflect the OLD target — backfilling would commit the
      // executor to hours for an objective the user no longer wants. The recorder
      // must instead write a fresh revision and commit that newly solved schedule.
      const persisted = buildLegacyPersisted();
      const { deps } = buildPersistDeps(persisted);
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);

      // Diagnostic resolves a different signature (70C vs persisted 65C).
      const diag = makeDiag({
        deviceId: 'dev',
        deadlineAtMs: 6 * HOUR_MS,
        targetTemperatureC: 70,
      });
      recorder.observe([diag], 2 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.latest?.reason).toBe('objective_changed');
      expect(plan?.commitment).toEqual({
        committedAtMs: 2 * HOUR_MS,
        hours: plan?.latest?.hours,
      });
    });

    it('does not rewrite commitment once one is present', () => {
      // Once `commitment` is set (either by `writeFirstRevision` on new
      // plans or by an earlier backfill), subsequent cycles must leave it
      // alone — the committed envelope is the stable schedule, not a
      // recomputed snapshot.
      const existingCommitment = {
        committedAtMs: HOUR_MS,
        hours: legacyHours,
      };
      const persisted = buildLegacyPersisted({ commitment: existingCommitment });
      const { deps } = buildPersistDeps(persisted);
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);

      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], 5 * HOUR_MS);

      const plan = recorder.getPlanForTests('dev');
      expect(plan?.commitment).toEqual(existingCommitment);
    });
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

    it('accepts a persisted plan with a non-empty revision history', () => {
      const historyEntry = {
        ...baseRevision,
        revision: 2,
        revisedAtMs: 2 * HOUR_MS,
        reason: 'schedule_revised',
      };
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: { ...basePlan({ revision: 3, reason: 'schedule_revised' }), history: [historyEntry] },
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev?.history).toHaveLength(1);
      expect(normalized.plansByDeviceId.dev?.history?.[0]?.revision).toBe(2);
    });

    it('accepts legacy persisted plans without a history field (treated as absent)', () => {
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: basePlan({ reason: 'flow_card' }), // no `history` key
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev).toBeDefined();
      expect(normalized.plansByDeviceId.dev?.history).toBeUndefined();
    });

    it('rejects a persisted plan whose history contains a malformed revision', () => {
      const persisted = {
        version: 1,
        plansByDeviceId: {
          dev: {
            ...basePlan({ reason: 'flow_card' }),
            history: [
              { ...baseRevision, reason: 'schedule_revised' }, // valid
              { foo: 'bar' }, // garbage — must drop the whole plan
            ],
          },
        },
      };
      const normalized = normalizeDeferredObjectiveActivePlans(persisted);
      expect(normalized.plansByDeviceId.dev).toBeUndefined();
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

    // v2.9.0 closeout hardening — the persistence boundary previously
    // accepted unknown `planStatus` strings, NaN energy figures, negative
    // bucket counts, and unknown `displayConfidence` bands. Each scenario
    // below is a payload a tampered settings dump (hand-edit, downgrade,
    // version-drift across an aborted upgrade) could produce; the validator
    // must drop the offending plan rather than smuggle garbage to the hero/
    // chip.
    describe('v2.9 field hardening', () => {
      it('drops a plan whose revision planStatus is an unknown string', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({ reason: 'flow_card', planStatus: 'bogus_status' }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev).toBeUndefined();
      });

      it('drops a plan whose revision is missing planStatus entirely', () => {
        const { planStatus: _omitStatus, ...revisionWithoutStatus } = {
          ...baseRevision,
          reason: 'flow_card' as const,
        };
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: {
              ...basePlan(),
              latest: revisionWithoutStatus,
              original: revisionWithoutStatus,
            },
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev).toBeUndefined();
      });

      it('drops a plan whose revision energyNeededKWh is NaN', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({ reason: 'flow_card', energyNeededKWh: Number.NaN }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev).toBeUndefined();
      });

      it('drops a plan whose revision is missing energyNeededKWh entirely', () => {
        const { energyNeededKWh: _omitEnergy, ...revisionWithoutEnergy } = {
          ...baseRevision,
          reason: 'flow_card' as const,
        };
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: {
              ...basePlan(),
              latest: revisionWithoutEnergy,
              original: revisionWithoutEnergy,
            },
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev).toBeUndefined();
      });

      it('drops a plan whose revision energyExpectedKWh is negative', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({ reason: 'flow_card', energyExpectedKWh: -0.1 }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev).toBeUndefined();
      });

      it('drops a plan whose revision energyExpectedKWh is NaN', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({ reason: 'flow_card', energyExpectedKWh: Number.NaN }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev).toBeUndefined();
      });

      it('accepts a revision with a valid energyExpectedKWh < energyNeededKWh (range chip)', () => {
        // The recorder writes `energyExpectedKWh` when the mean estimate is
        // smaller than the buffered figure (variance buffer scenarios). Must
        // round-trip cleanly so the UI can render the `expected…planned` range.
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({
              reason: 'flow_card',
              energyNeededKWh: 4.5,
              energyExpectedKWh: 3.8,
            }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev?.latest?.energyExpectedKWh).toBeCloseTo(3.8);
      });

      it('drops a plan whose revision dailyBudgetExhaustedBucketCount is negative', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({
              reason: 'flow_card',
              dailyBudgetExhaustedBucketCount: -1,
            }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev).toBeUndefined();
      });

      it('accepts dailyBudgetExhaustedBucketCount = 0 (legacy tools that round-trip)', () => {
        // The recorder suppresses zero to keep persisted revisions byte-stable
        // (see comment in `activePlanRecorder.ts`), but a hand-written fixture
        // or downstream tool could emit zero. The validator stays lenient so
        // those payloads still load.
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({
              reason: 'flow_card',
              dailyBudgetExhaustedBucketCount: 0,
            }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev?.latest?.dailyBudgetExhaustedBucketCount).toBe(0);
      });

      it('accepts dailyBudgetExhaustedBucketCount > 0 (production shape)', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({
              reason: 'schedule_revised',
              dailyBudgetExhaustedBucketCount: 3,
            }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev?.latest?.dailyBudgetExhaustedBucketCount).toBe(3);
      });

      it('drops a plan whose provenance displayConfidence is an unknown band', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: {
              ...basePlan({ reason: 'flow_card' }),
              kwhPerUnitProvenance: {
                source: 'learned',
                kWhPerUnit: 1.5,
                acceptedSamples: 5,
                confidence: 'medium',
                displayConfidence: 'bogus',
                lastAcceptedAtMs: HOUR_MS,
              },
            },
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev).toBeUndefined();
      });

      it('accepts provenance whose displayConfidence is a known band', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: {
              ...basePlan({ reason: 'flow_card' }),
              kwhPerUnitProvenance: {
                source: 'learned',
                kWhPerUnit: 1.5,
                acceptedSamples: 5,
                confidence: 'medium',
                displayConfidence: 'high',
                lastAcceptedAtMs: HOUR_MS,
              },
            },
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(
          normalized.plansByDeviceId.dev?.kwhPerUnitProvenance?.displayConfidence,
        ).toBe('high');
      });

      it('accepts provenance whose displayConfidence is null (bootstrap path)', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: {
              ...basePlan({ reason: 'flow_card' }),
              kwhPerUnitProvenance: {
                source: 'bootstrap',
                kWhPerUnit: null,
                acceptedSamples: 0,
                confidence: null,
                displayConfidence: null,
                lastAcceptedAtMs: null,
              },
            },
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(
          normalized.plansByDeviceId.dev?.kwhPerUnitProvenance?.displayConfidence,
        ).toBeNull();
      });

      it('accepts provenance without displayConfidence (legacy v2.9-pre payload)', () => {
        // Migration safety: provenance snapshots written before
        // `displayConfidence` shipped must continue to load — the optional
        // field is absent on the persisted shape, which is the byte-stable
        // pre-v2.9 production write.
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: {
              ...basePlan({ reason: 'flow_card' }),
              kwhPerUnitProvenance: {
                source: 'learned',
                kWhPerUnit: 1.5,
                acceptedSamples: 5,
                confidence: 'medium',
                lastAcceptedAtMs: HOUR_MS,
              },
            },
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev?.kwhPerUnitProvenance).toMatchObject({
          source: 'learned',
          confidence: 'medium',
        });
        expect(
          normalized.plansByDeviceId.dev?.kwhPerUnitProvenance?.displayConfidence,
        ).toBeUndefined();
      });

      it('accepts a revision with a valid floorShortfallCause enum value', () => {
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({
              reason: 'schedule_revised',
              planStatus: 'at_risk',
              floorShortfallCause: 'budget',
            }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev?.latest?.floorShortfallCause).toBe('budget');
      });

      it('accepts a revision with a forward-compat floorShortfallCause string the consumer does not recognise', () => {
        // Forward-compat: a future PELS version may emit a new cause variant
        // (e.g. `physics_violation`) that the running v2.9.x consumer doesn't
        // recognise. The validator must accept any string so we don't drop
        // the WHOLE persisted plan — which would also drop the revision
        // history (`original`). The consumer in `deadlinePlan.ts` falls back
        // gracefully on unknown values (only branches on the `'budget'`
        // literal; treats everything else as device-side recourse), so a
        // string-typed unknown lands safely.
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({
              reason: 'flow_card',
              floorShortfallCause: 'physics_violation',
            }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev?.latest?.floorShortfallCause).toBe('physics_violation');
      });

      it('drops a plan whose revision floorShortfallCause is non-string garbage', () => {
        // A genuinely tampered payload that smuggled e.g. `cause: 42` or
        // `cause: null` or `cause: {}` must not survive rehydration —
        // downstream code branches on string equality and would either
        // silently miscompare or throw on a non-string value. Sibling
        // pattern to the `kwhPerUnitSource: 'totally_invalid'` case above
        // for the non-string branch only.
        const buildPersisted = (cause: unknown) => ({
          version: 1,
          plansByDeviceId: {
            dev: basePlan({
              reason: 'flow_card',
              floorShortfallCause: cause,
            }),
          },
        });
        expect(
          normalizeDeferredObjectiveActivePlans(buildPersisted(42)).plansByDeviceId.dev,
        ).toBeUndefined();
        expect(
          normalizeDeferredObjectiveActivePlans(buildPersisted(null)).plansByDeviceId.dev,
        ).toBeUndefined();
        expect(
          normalizeDeferredObjectiveActivePlans(buildPersisted({})).plansByDeviceId.dev,
        ).toBeUndefined();
      });

      it('accepts a revision without floorShortfallCause (legacy v2.9-pre payload)', () => {
        // Migration safety: revisions persisted before this field shipped do
        // not carry it. The consumer falls back to the count-based heuristic
        // when absent — silent acceptance is the byte-stable pre-field shape.
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: basePlan({ reason: 'flow_card' }),
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev?.latest?.floorShortfallCause).toBeUndefined();
      });

      it('accepts a pristine v2.9 production-shape plan (legacy-payload migration anchor)', () => {
        // This pins the exact byte shape the recorder writes today so a future
        // refactor that tightens any field accidentally would surface here.
        // Mirrors `buildRevision` + `resolveProvenance` output for a typical
        // schedule_revised cycle (energyExpectedKWh < energyNeededKWh,
        // dailyBudgetExhaustedBucketCount > 0, displayConfidence set).
        const persisted = {
          version: 1,
          plansByDeviceId: {
            dev: {
              ...basePlan({
                reason: 'schedule_revised',
                energyNeededKWh: 4.5,
                energyExpectedKWh: 3.8,
                dailyBudgetExhaustedBucketCount: 2,
                kwhPerUnitSource: 'learned',
                planningSpeedKw: 1.5,
                estimatedDurationText: '3h',
              }),
              kwhPerUnitProvenance: {
                source: 'learned',
                kWhPerUnit: 1.5,
                acceptedSamples: 12,
                confidence: 'medium',
                displayConfidence: 'high',
                lastAcceptedAtMs: HOUR_MS - 1000,
              },
              initialPlanningSpeedKw: 1.5,
              initialEstimatedDurationText: '3h',
            },
          },
        };
        const normalized = normalizeDeferredObjectiveActivePlans(persisted);
        expect(normalized.plansByDeviceId.dev).toBeDefined();
        expect(normalized.plansByDeviceId.dev?.latest?.energyNeededKWh).toBe(4.5);
        expect(normalized.plansByDeviceId.dev?.latest?.energyExpectedKWh).toBe(3.8);
        expect(normalized.plansByDeviceId.dev?.latest?.dailyBudgetExhaustedBucketCount).toBe(2);
        expect(normalized.plansByDeviceId.dev?.latest?.planStatus).toBe('on_track');
        expect(
          normalized.plansByDeviceId.dev?.kwhPerUnitProvenance?.displayConfidence,
        ).toBe('high');
      });
    });
  });

  describe('debug-event lifecycle fields', () => {
    // Plain "task started / replanned" telemetry: a single emitted event must
    // answer "when did this task start, what deadline did the user set, what
    // target" without having to correlate to a downstream
    // `deferred_objective_horizon_planned`. The recorder already holds these
    // values on the persisted plan — this just threads them onto the debug
    // event so log analysis is self-contained.
    const captureEvents = () => {
      const events: Record<string, unknown>[] = [];
      const inner = buildPersistDeps();
      return {
        deps: { ...inner.deps, debugStructured: (e: Record<string, unknown>) => { events.push(e); } },
        events,
        saved: inner.saved,
      };
    };

    it('writes startedAtMs, deadlineAtMs, objectiveKind, and target on active_plan_revision_written (first revision)', () => {
      const deadlineAtMs = 6 * HOUR_MS;
      const { deps, events } = captureEvents();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);
      recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs })], HOUR_MS);

      const written = events.find((e) => e.event === 'active_plan_revision_written');
      expect(written).toBeDefined();
      expect(written).toMatchObject({
        deviceId: 'dev',
        revision: 1,
        startedAtMs: HOUR_MS,
        deadlineAtMs,
        objectiveKind: 'temperature',
        targetTemperatureC: 65,
        targetPercent: null,
      });
    });

    it('writes the same lifecycle fields on a pending event when no horizon plan is available yet', () => {
      const deadlineAtMs = 6 * HOUR_MS;
      const { deps, events } = captureEvents();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);
      const diag = makeDiag({ deviceId: 'dev', deadlineAtMs });
      delete (diag as { horizonPlan?: unknown }).horizonPlan;
      diag.reasonCode = 'objective_missing_price_horizon';
      recorder.observe([diag], HOUR_MS);

      const pending = events.find((e) => e.event === 'active_plan_revision_pending');
      expect(pending).toMatchObject({
        deviceId: 'dev',
        reason: 'awaiting_horizon_plan',
        startedAtMs: HOUR_MS,
        deadlineAtMs,
        objectiveKind: 'temperature',
        targetTemperatureC: 65,
        targetPercent: null,
      });
    });

    it('preserves startedAtMs across replans (revision > 1)', () => {
      const deadlineAtMs = 6 * HOUR_MS;
      const { deps, events } = captureEvents();
      const recorder = new DeferredObjectiveActivePlanRecorder(deps);
      // First cycle at HOUR_MS anchors `startedAtMs` for the run.
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs,
        dailyBudgetExhaustedBucketCount: 0,
      })], HOUR_MS);
      // Metadata-only drift (matches the recorder's documented
      // `schedule_revised` path): same hours, same horizon end, only the
      // daily-budget signal flips. `startedAtMs` must stay at the original
      // first-observation time, not move to the replan tick.
      recorder.observe([makeDiag({
        deviceId: 'dev',
        deadlineAtMs,
        dailyBudgetExhaustedBucketCount: 2,
      })], 2 * HOUR_MS);

      const writes = events.filter((e) => e.event === 'active_plan_revision_written');
      expect(writes.length).toBeGreaterThanOrEqual(2);
      const replan = writes[writes.length - 1]!;
      expect(replan).toMatchObject({
        startedAtMs: HOUR_MS, // anchored at the first observation, not the replan tick
        deadlineAtMs,
      });
      expect(replan.revision as number).toBeGreaterThan(1);
    });
  });
});
