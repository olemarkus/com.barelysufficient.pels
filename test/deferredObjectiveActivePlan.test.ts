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

  it('calls onRevisionWritten with allocationChanged=true and projectedFinishAtMs from last bucket fill', () => {
    const events: Array<{
      deviceId: string;
      reason: string;
      allocationChanged: boolean;
      hours: number;
      energyNeededKWh: number;
      projectedFinishAtMs: number | null;
      accumulatedHourCount: number;
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
          accumulatedHourCount: event.accumulatedHourCount,
        });
      },
    });

    // First observe seeds the plan — no revision-written notification (only replans fire).
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    expect(events).toEqual([]);

    // Second observe shifts the bucket allocation. Last bucket starts at
    // 5h and fills 1.0 of its 3.0 kWh capacity → finish 1/3 of an hour in.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.0),
      ]),
    })], 2 * HOUR_MS);

    expect(events).toHaveLength(1);
    // First revision had startsAtMs {2h, 3h, 4h}; second has {1h, 2h, 5h}.
    // Union is 5 distinct hours.
    expect(events[0]).toEqual({
      deviceId: 'dev',
      reason: 'prices_revised',
      allocationChanged: true,
      hours: 3,
      energyNeededKWh: 4.0,
      projectedFinishAtMs: 5 * HOUR_MS + Math.round((1.0 / 3.0) * HOUR_MS),
      accumulatedHourCount: 5,
    });

    // Third observe with identical hours — no further notification.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.0),
      ]),
    })], 3 * HOUR_MS);
    expect(events).toHaveLength(1);
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

  it('emits a monotonic accumulatedHourCount as elapsed hours drop off the horizon', () => {
    const events: Array<{ reason: string; hours: number; accumulatedHourCount: number }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => {
        events.push({
          reason: event.reason,
          hours: event.revision.hours.length,
          accumulatedHourCount: event.accumulatedHourCount,
        });
      },
    });

    // Seed at nowMs=1h with three planned hours [2h, 3h, 4h]. No event.
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);

    // Replan at nowMs=2h shifts future allocation to [3h, 4h, 5h] — first
    // elapsed/dropped hour (2h) is still counted in the accumulated total.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(3 * HOUR_MS, 1.5),
        makeBucket(4 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 2 * HOUR_MS);

    // Replan at nowMs=4h drops to a single future hour [5h].
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      horizonPlan: makeHorizon([
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 4 * HOUR_MS);

    expect(events).toEqual([
      { reason: 'prices_revised', hours: 3, accumulatedHourCount: 4 },
      { reason: 'prices_revised', hours: 1, accumulatedHourCount: 4 },
    ]);
    // revision.hours stays future-only — settings UI and other consumers
    // continue to see "remaining allocation", not a lifetime hour log.
    expect(recorder.getPlanForTests('dev')?.latest?.hours).toEqual([
      { startsAtMs: 5 * HOUR_MS, plannedKWh: 1.5 },
    ]);
  });

  it('resets accumulatedHourCount when the objective itself changes', () => {
    const events: Array<{ reason: string; accumulatedHourCount: number }> = [];
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder({
      ...deps,
      onRevisionWritten: (event) => {
        events.push({ reason: event.reason, accumulatedHourCount: event.accumulatedHourCount });
      },
    });

    // Seed with target 65°C, deadline 6h.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      targetTemperatureC: 65,
    })], HOUR_MS);

    // User raises target to 70°C at nowMs=4h. Same deadline, different
    // objective signature → the accumulated counter resets.
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      targetTemperatureC: 70,
      horizonPlan: makeHorizon([
        makeBucket(4 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 4 * HOUR_MS);

    expect(events).toEqual([
      { reason: 'objective_changed', accumulatedHourCount: 2 },
    ]);
  });

  it('emits a prices_revised revision when the bucket plan shifts but the objective is unchanged', () => {
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    recorder.observe([makeDiag({
      deviceId: 'dev',
      deadlineAtMs: 6 * HOUR_MS,
      // Same target and deadline, different cheap-hour selection:
      horizonPlan: makeHorizon([
        makeBucket(HOUR_MS, 1.5),
        makeBucket(2 * HOUR_MS, 1.5),
        makeBucket(5 * HOUR_MS, 1.5),
      ]),
    })], 2 * HOUR_MS);

    const plan = recorder.getPlanForTests('dev');
    expect(plan?.latest?.reason).toBe('prices_revised');
    expect(plan?.latest?.revision).toBe(2);
    expect(plan?.original?.revision).toBe(1);
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

  it('stays on prices_revised when source is unchanged across a price shift', () => {
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

    expect(recorder.getPlanForTests('dev')?.latest?.reason).toBe('prices_revised');
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
    // allocation-change revision `prices_revised`.
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
    expect(plan?.latest?.reason).toBe('prices_revised');
    expect(plan?.latest?.kwhPerUnitSource).toBeUndefined();
    expect(plan?.latest?.revision).toBe(2);
  });

  it('writes a prices_revised revision when source flips learned→bootstrap even with identical hours', () => {
    // Regression for PR #708 review: if the profile is pruned (or the device
    // is removed/re-added) and the bucket allocation happens to be
    // byte-identical across the source flip, the recorder must still write a
    // revision so persisted `kwhPerUnitSource` does not stay stale at
    // 'learned' while the planner is using bootstrap.
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
    expect(plan?.latest?.reason).toBe('prices_revised');
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

  it('reflects an objective_changed revision when markPending precedes observe with a different target', () => {
    // Regression: markPending on the same deadline must NOT update the stored
    // objectiveSignature, otherwise the next observe() cycle sees matching
    // signatures and writes `prices_revised` (or skips) instead of
    // `objective_changed`. See PR #643 review threads 4 and 6.
    const { deps } = buildPersistDeps();
    const recorder = new DeferredObjectiveActivePlanRecorder(deps);

    // 1. Establish an active plan for target 65 °C.
    recorder.observe([makeDiag({ deviceId: 'dev', deadlineAtMs: 6 * HOUR_MS })], HOUR_MS);
    expect(recorder.getPlanForTests('dev')?.latest?.reason).toBe('flow_card');

    // 2. User edits the target via the flow card; markPending fires with a
    //    new target but the same deadline.
    recorder.markPending(buildSeed({ targetTemperatureC: 70 }), 2 * HOUR_MS);

    // 3. The next plan cycle observes a diagnostic with the new target.
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
    expect(plan?.latest?.reason).toBe('objective_changed');
    expect(plan?.latest?.revision).toBe(2);
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
  });
});
