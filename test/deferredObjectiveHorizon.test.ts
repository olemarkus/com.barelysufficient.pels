import { planDeferredObjectiveHorizon } from '../lib/plan/deferredObjectives';
import type {
  DeferredObjective,
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveStep,
} from '../lib/plan/deferredObjectives';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1, 17);

const defaultSteps: DeferredObjectiveStep[] = [
  { id: 'off', usefulPowerKw: 0 },
  { id: 'low', usefulPowerKw: 1 },
  { id: 'medium', usefulPowerKw: 2 },
  { id: 'max', usefulPowerKw: 3 },
];

const bucket = (
  hourOffset: number,
  preference: DeferredObjectiveHorizonBucket['preference'] = 'neutral',
  overrides: Partial<DeferredObjectiveHorizonBucket> = {},
): DeferredObjectiveHorizonBucket => ({
  id: `h${hourOffset}`,
  startMs: NOW_MS + (hourOffset * HOUR_MS),
  endMs: NOW_MS + ((hourOffset + 1) * HOUR_MS),
  preference,
  ...overrides,
});

const objective = (overrides: Partial<DeferredObjective> = {}): DeferredObjective => ({
  id: 'charger',
  kind: 'ev_soc',
  enforcement: 'soft',
  energyNeededKWh: 2,
  deadlineAtMs: NOW_MS + (4 * HOUR_MS),
  ...overrides,
});

const plannedBySourceBucket = (
  buckets: ReturnType<typeof planDeferredObjectiveHorizon>['plannedBuckets'],
  sourceBucketId: string,
): number => {
  let planned = 0;
  for (const plannedBucket of buckets) {
    if (plannedBucket.sourceBucketId === sourceBucketId) {
      planned += plannedBucket.plannedUsefulEnergyKWh;
    }
  }
  return planned;
};

const plannedBucket = (
  buckets: ReturnType<typeof planDeferredObjectiveHorizon>['plannedBuckets'],
  id: string,
) => buckets.find((candidate) => candidate.id === id);

describe('planDeferredObjectiveHorizon', () => {
  it('waits through the current bucket when future preferred windows cover the objective', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective(),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'avoid'),
        bucket(1, 'preferred'),
        bucket(2, 'preferred'),
      ],
    });

    expect(plan.status).toBe('on_track');
    expect(plan.requestedMinimumStepId).toBeNull();
    expect(plan.currentBucket?.plannedUsefulEnergyKWh).toBe(0);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBeCloseTo(1);
  });

  it('plans against the lowest non-zero step even when a higher step exists', () => {
    // We commit to running the lowest step for the full hour; higher steps may
    // be denied mid-bucket, so the planner does not bet on stepping up. With a
    // 2 kWh need across two preferred hours and a 1 kW low step, the plan must
    // schedule both hours instead of stuffing 2 kWh into one hour via 'high'.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + (2 * HOUR_MS),
      }),
      steps: [
        { id: 'low', usefulPowerKw: 1 },
        { id: 'high', usefulPowerKw: 2 },
      ],
      buckets: [
        bucket(0, 'avoid'),
        bucket(1, 'preferred'),
      ],
    });

    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('planned_using_policy_avoid');
    expect(plan.usesPolicyAvoid).toBe(true);
    expect(plan.requestedMinimumStepId).toBe('low');
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
  });

  it('requests the lowest current step that keeps the selected windows on track', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective(),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
        bucket(1, 'preferred'),
      ],
    });

    expect(plan.status).toBe('on_track');
    expect(plan.requestedMinimumStepId).toBe('low');
    expect(plan.currentBucket?.plannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('keeps committed hours even when a fresh optimization would prefer another bucket', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'avoid'),
        bucket(1, 'preferred'),
        bucket(2, 'avoid'),
      ],
      committed: true,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 1 },
        { startsAtMs: NOW_MS + (2 * HOUR_MS), plannedKWh: 1 },
      ],
    });

    expect(plan.status).toBe('at_risk');
    expect(plan.requestedMinimumStepId).toBe('low');
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBe(0);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBeCloseTo(1);
  });

  it('treats committed=true with empty hours as a commitment to zero hours (not a re-optimization request)', () => {
    // Models a previously stored `cannot_meet` plan that allocated zero hours.
    // The producer (diagnosticsBridge) still reports `committed: true` so the
    // planner stays on the committed-replan path and reports the full
    // energyNeededKWh as unplanned — it does not silently rerun the fresh
    // optimizer against the same horizon and "recover".
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
        bucket(1, 'preferred'),
        bucket(2, 'preferred'),
      ],
      committed: true,
      committedHours: [],
    });

    expect(plan.status).toBe('cannot_meet');
    expect(plan.statusDetail).toBe('target_cannot_be_met');
    expect(plan.plannedUsefulEnergyKWh).toBe(0);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(2);
  });

  it('expands a committed plan when residual energy is needed and uncommitted preferred buckets remain', () => {
    // Prod scenario (Connected 300, 2026-05-26): a smart task reached `satisfied`
    // at 22:58 with the original commitment fully delivered, then drifted below
    // target through the night as standby loss accumulated. `energyNeededKWh`
    // recomputed on each cycle, but the committed-replan path could only fill
    // *within* the original committed hours — never adding the still-available
    // cheap preferred buckets remaining in the horizon. Result: status stayed
    // `cannot_meet` for 7 hours and the tank reached the deadline ~8 °C below
    // target despite a wide selection of unused preferred buckets.
    //
    // Modelled here as a non-empty commitment (hour 0 = 1 kWh) facing a
    // refreshed need of 2 kWh: the committed hour delivers 1 kWh; the residual
    // 1 kWh must spill into an uncommitted preferred bucket. Hour 1 wins the
    // sort (preferred + earliest among ties), so it gets the expansion. Hour 2
    // stays unallocated because the need is already met.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'neutral'),
        bucket(1, 'preferred'),
        bucket(2, 'preferred'),
      ],
      committed: true,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 1 },
      ],
    });

    expect(plan.status).toBe('on_track');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBe(0);
  });

  it('skips partially-filtered committed hours (sub-epsilon entries) during expansion', () => {
    // Adversarial-review follow-up (gemini): a commitment whose *some* entries
    // were sub-epsilon or non-finite would pass the `committedRemainingByHour`
    // skip check (those filtered hours don't appear in the map) — and
    // expansion could allocate fresh energy into them, violating the
    // commitment ceiling of zero for those specific hours. The expansion's
    // skip set must be built from the raw `committedHours` array, not from
    // the filtered map.
    //
    // Two committed hours: hour 0 has 1 kWh, hour 1 has explicit 0 (the user
    // earmarked that slot but with zero allocation). Need 2 kWh total. Phase
    // 1 fills hour 0 with 1 kWh; shortfall is 1 kWh. Phase 2 must NOT
    // allocate to hour 1 (committed-as-zero); it should fall through to hour
    // 2 (genuinely uncommitted preferred).
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
        bucket(1, 'preferred'),
        bucket(2, 'preferred'),
      ],
      committed: true,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 1 },
        { startsAtMs: NOW_MS + HOUR_MS, plannedKWh: 0 },
      ],
    });

    expect(plan.status).toBe('on_track');
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBe(0);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBeCloseTo(1);
  });

  it('does not expand when every committed hour is filtered out (corrupt or sub-epsilon)', () => {
    // Adversarial-review finding: gating expansion on `committedHours.length`
    // would let a commitment whose entries all got filtered out by
    // `buildCommittedHourMap` (non-finite values from migration drift, or
    // sub-epsilon plannedKWh from rounding) slip through and silently
    // recover. That is exactly the case the `committed: true, hours: []`
    // invariant test covers — it must not regress through this back door.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
        bucket(1, 'preferred'),
        bucket(2, 'preferred'),
      ],
      committed: true,
      committedHours: [
        // Sub-epsilon entry — survives the array but gets filtered from the
        // committed-hour map. Equivalent in effect to a zero-hour commitment.
        { startsAtMs: NOW_MS, plannedKWh: 0.0001 },
      ],
    });

    expect(plan.status).toBe('cannot_meet');
    expect(plan.plannedUsefulEnergyKWh).toBe(0);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(2);
  });

  it('does not double-allocate inside an already-committed hour during expansion', () => {
    // Phase-2 expansion fills *uncommitted* hours only. A committed hour that
    // is partially used (e.g. committed 0.5 kWh of a 1 kWh capacity) keeps its
    // commitment as the binding ceiling for that hour — expansion adds new
    // hours, not capacity within existing ones. Future replans can resize a
    // hour's commitment via the normal revision flow.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
        bucket(1, 'preferred'),
        bucket(2, 'preferred'),
      ],
      committed: true,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 0.5 },
      ],
    });

    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(0.5);
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
  });

  it('runs the fresh optimizer when committed is false regardless of committedHours', () => {
    // Regression guard: an explicit `committed: false` must route to the fresh
    // optimizer even when `committedHours` is non-empty (e.g. a stale legacy
    // payload). Same buckets as the committed=true/empty case, but with a
    // populated committedHours array pointing at a worse hour. The fresh
    // optimizer would prefer all three `preferred` buckets, so an `on_track`
    // result with the full energy planned proves the `committed: false` flag
    // wins over the supplied committedHours data.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
        bucket(1, 'preferred'),
        bucket(2, 'preferred'),
      ],
      committed: false,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 1 },
        { startsAtMs: NOW_MS + (2 * HOUR_MS), plannedKWh: 1 },
      ],
    });

    expect(plan.status).toBe('on_track');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plan.unplannedUsefulEnergyKWh).toBe(0);
  });

  it('reports at_risk (feasible_above_floor) when the floor falls short but climbing a higher step fits', () => {
    // 2 kWh needed in a single 1-hour bucket. The guaranteed floor (low = 1 kW)
    // delivers only 1 kWh, so the commitment is short — but the executor climbs
    // to higher steps when capacity allows, and the top step (max = 3 kW) would
    // fit the full 2 kWh. That is reachable-by-climbing, not impossible, so the
    // verdict is at_risk rather than a flat cannot_meet false negative.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + HOUR_MS,
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'neutral'),
      ],
    });

    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('feasible_above_floor');
    // The commitment itself still only plans the guaranteed floor (1 kWh).
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(1);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('still reports cannot_meet when the target does not fit even at the top step', () => {
    // 10 kWh needed in a single 1-hour bucket. Even the top step (max = 3 kW)
    // delivers only 3 kWh, so the target is physically unreachable — climbing
    // cannot rescue it and the verdict stays cannot_meet.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 10,
        deadlineAtMs: NOW_MS + HOUR_MS,
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'neutral'),
      ],
    });

    expect(plan.status).toBe('cannot_meet');
    expect(plan.statusDetail).toBe('target_cannot_be_met');
  });

  it('keeps cannot_meet for a single-step device that cannot climb', () => {
    // A device with one usable step (e.g. an EV charger) has no higher step to
    // climb to, so a floor shortfall is a genuine miss, not feasible_above_floor.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + HOUR_MS,
      }),
      steps: [
        { id: 'charge', usefulPowerKw: 1 },
      ],
      buckets: [
        bucket(0, 'neutral'),
      ],
    });

    expect(plan.status).toBe('cannot_meet');
    expect(plan.statusDetail).toBe('target_cannot_be_met');
  });

  it('keeps cannot_meet for a committed plan that is short, since the climbed probe respects committed caps', () => {
    // Committed to 1 kWh in the only available hour, but 2 kWh is needed. The
    // climbed probe mirrors the committed mode, so the per-hour committed cap
    // (1 kWh) still binds even at the top step — climbing within committed
    // hours cannot manufacture feasibility, so the verdict stays cannot_meet
    // rather than silently recovering to feasible_above_floor.
    //
    // The single-bucket horizon also rules out phase-2 expansion (no
    // uncommitted preferred buckets to spill into), so this case isolates the
    // climbed-probe invariant from the committed-plan-expansion path.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + HOUR_MS,
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
      ],
      committed: true,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 1 },
      ],
    });

    expect(plan.status).toBe('cannot_meet');
    expect(plan.statusDetail).toBe('target_cannot_be_met');
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('reports at_risk (limited_by_daily_budget) when the floor is short only because of the per-bucket budget cap', () => {
    // 3 kWh needed across four 1-hour buckets, each capped at 0.5 kWh by the
    // per-bucket daily-budget cap (`maxUsefulEnergyKWh`). The floor can place only
    // 2.0 kWh, and climbing a higher step cannot help — the cap bounds every step
    // equally. But with the cap lifted the device physically fits the full 3 kWh,
    // so the shortfall is budget-bound: at_risk, not a physical cannot_meet.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 3,
        deadlineAtMs: NOW_MS + (4 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'neutral', { maxUsefulEnergyKWh: 0.5 }),
        bucket(1, 'neutral', { maxUsefulEnergyKWh: 0.5 }),
        bucket(2, 'neutral', { maxUsefulEnergyKWh: 0.5 }),
        bucket(3, 'neutral', { maxUsefulEnergyKWh: 0.5 }),
      ],
    });

    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('limited_by_daily_budget');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('keeps cannot_meet when even the budget-uncapped horizon cannot fit (physical/time limit)', () => {
    // Same per-bucket budget caps, but 20 kWh is needed: even with the cap lifted,
    // four hours at the top step (3 kW) deliver only 12 kWh. The shortfall is
    // genuinely physical/time-bound, not budget-bound — so a budget cap must not
    // mask it as recoverable.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 20,
        deadlineAtMs: NOW_MS + (4 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'neutral', { maxUsefulEnergyKWh: 0.5 }),
        bucket(1, 'neutral', { maxUsefulEnergyKWh: 0.5 }),
        bucket(2, 'neutral', { maxUsefulEnergyKWh: 0.5 }),
        bucket(3, 'neutral', { maxUsefulEnergyKWh: 0.5 }),
      ],
    });

    expect(plan.status).toBe('cannot_meet');
    expect(plan.statusDetail).toBe('target_cannot_be_met');
  });

  it('reports at_risk (estimate_uncertain) when the floor shortfall fits inside the variance margin', () => {
    // Single-step device (so climbing can't rescue) with no budget caps (so the
    // budget-bound probe finds the same uncapped capacity). Buffered need is
    // 2.5 kWh; the mean is 2.0 kWh, so the producer's `k·SE` margin is 0.5 kWh.
    // The 2 kW step over 1 h delivers 2.0 kWh — exactly the mean — leaving a
    // 0.5 kWh shortfall that sits at the margin boundary. The mean would fit;
    // only the conservative buffer pads us short. Soften to at_risk/
    // estimate_uncertain rather than declaring physical cannot_meet.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2.5,
        energyExpectedKWh: 2.0,
        deadlineAtMs: NOW_MS + HOUR_MS,
      }),
      steps: [
        { id: 'one', usefulPowerKw: 2 },
      ],
      buckets: [
        bucket(0, 'neutral'),
      ],
    });

    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('estimate_uncertain');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(0.5);
  });

  it('still reports cannot_meet when the shortfall exceeds the variance margin', () => {
    // Same single-step device, but the shortfall (1 kWh) is larger than the
    // producer's `k·SE` margin (0.5 kWh) — the mean wouldn't fit either, so
    // this is a genuine cannot_meet; the variance buffer doesn't excuse it.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 3,
        energyExpectedKWh: 2.5,
        deadlineAtMs: NOW_MS + HOUR_MS,
      }),
      steps: [
        { id: 'one', usefulPowerKw: 2 },
      ],
      buckets: [
        bucket(0, 'neutral'),
      ],
    });

    expect(plan.status).toBe('cannot_meet');
    expect(plan.statusDetail).toBe('target_cannot_be_met');
  });

  it('does not invoke estimate_uncertain when energyExpectedKWh is absent (backward-compat: margin collapses to zero)', () => {
    // Legacy callers that don't pass `energyExpectedKWh` (or pass it equal to
    // `energyNeededKWh`) must produce the pre-Step-3 verdict. With no margin,
    // any unplanned > epsilon is `cannot_meet`.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2.5,
        deadlineAtMs: NOW_MS + HOUR_MS,
      }),
      steps: [
        { id: 'one', usefulPowerKw: 2 },
      ],
      buckets: [
        bucket(0, 'neutral'),
      ],
    });

    expect(plan.status).toBe('cannot_meet');
    expect(plan.statusDetail).toBe('target_cannot_be_met');
  });

  // ---------- Slice 2: reserved-headroom committed-floor promotion ----------
  // When the objective is fully reserved (both `exemptFromBudget` and
  // `limitLowerPriorityDevices` set to 'always'), the planner promotes the
  // committed floor from `activeSteps[0]` to the highest step the per-bucket
  // `reservedHeadroomKw` forecast supports (v1: per-horizon minimum across
  // buckets). The commitment is still physical — `hard-cap-is-physical` holds.

  it('promotes the committed floor to the top step when reserved headroom fits and the task is fully reserved', () => {
    // Need 18 kWh across 8h. Min step = 1 kW → 8 kWh → cannot_meet. Top step
    // = 3 kW → 24 kWh → fits. reservedHeadroomKw = 4 (≥ top step). With
    // `fullyReserved`, the floor is promoted to the top step and the plan is
    // on_track. (Without promotion, this is exactly the false `cannot_meet`
    // that motivates Slice 2.)
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 18,
        deadlineAtMs: NOW_MS + (8 * HOUR_MS),
        fullyReserved: true,
      }),
      steps: defaultSteps,
      buckets: Array.from({ length: 8 }, (_, i) => bucket(i, 'neutral', { reservedHeadroomKw: 4 })),
    });

    expect(plan.status).toBe('on_track');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(18);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(0);
  });

  it('promotes the floor only as high as the minimum per-bucket headroom allows', () => {
    // headroom = 2.5 → fits medium step (2 kW) but not max (3 kW). Floor goes
    // to medium. Need 16 kWh in 8h → 8h × 2 kW = 16 kWh → fits.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 16,
        deadlineAtMs: NOW_MS + (8 * HOUR_MS),
        fullyReserved: true,
      }),
      steps: defaultSteps,
      buckets: Array.from({ length: 8 }, (_, i) => bucket(i, 'neutral', { reservedHeadroomKw: 2.5 })),
    });

    expect(plan.status).toBe('on_track');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(16);
  });

  it('keeps the floor at min step when even the minimum headroom does not fit a higher step', () => {
    // headroom = 0.5 — less than min step (1 kW). Promotion picks the
    // rightmost step that fits, defaulting to the min step when even it
    // doesn't. Need 4 kWh in 4h → at min step 4 kWh fits exactly.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 4,
        deadlineAtMs: NOW_MS + (4 * HOUR_MS),
        fullyReserved: true,
      }),
      steps: defaultSteps,
      buckets: Array.from({ length: 4 }, (_, i) => bucket(i, 'neutral', { reservedHeadroomKw: 0.5 })),
    });

    expect(plan.status).toBe('on_track');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(4);
    // The per-bucket placed kWh shows the floor stayed at min step (1 kW × 1h = 1).
    expect(plan.plannedBuckets[0]?.plannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('uses the minimum across buckets (per-horizon v1) — a single tight bucket holds the whole horizon to min step', () => {
    // 7 generous buckets (headroom 4) + 1 tight (headroom 0.5). The v1
    // per-horizon model uses the *minimum* so the chosen floor is safe in
    // every bucket. → floor stays at min step → 1 kWh/h × 8h = 8 kWh placed
    // out of 18 needed. The shortfall is still climbable (Slice-1 catches it)
    // so the verdict softens to `at_risk`/`feasible_above_floor`, not a flat
    // miss — which is the correct composition of Slices 1 + 2.
    const headrooms = [4, 4, 0.5, 4, 4, 4, 4, 4];
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 18,
        deadlineAtMs: NOW_MS + (8 * HOUR_MS),
        fullyReserved: true,
      }),
      steps: defaultSteps,
      buckets: headrooms.map((h, i) => bucket(i, 'neutral', { reservedHeadroomKw: h })),
    });

    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('feasible_above_floor');
    // Floor stayed at min step → max ~1 kWh placed per bucket.
    expect(plan.plannedBuckets[0]?.plannedUsefulEnergyKWh).toBeCloseTo(1);
    // 8 buckets × 1 kWh — confirms the floor did not promote.
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(8);
  });

  it('falls back to min step when any bucket lacks a reservedHeadroomKw forecast — we cannot promise more than we can verify', () => {
    // Two buckets carry headroom = 4; one is missing the forecast field. The
    // resolver fails closed (returns min step) — Slice 2 only promotes when
    // the producer has resolved a forecast for every horizon bucket. The
    // shortfall remains classified by Slice-1's climbed-band probe.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 8,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
        fullyReserved: true,
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'neutral', { reservedHeadroomKw: 4 }),
        bucket(1, 'neutral'), // no reservedHeadroomKw
        bucket(2, 'neutral', { reservedHeadroomKw: 4 }),
      ],
    });

    // Climbed-band probe (top step) DOES fit 8 kWh in 3 h (3 × 3 = 9), so the
    // verdict softens to at_risk. Slice-2's job is only "verify we can promote
    // the *floor*"; classification correctness still belongs to Slice 1.
    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('feasible_above_floor');
    expect(plan.plannedBuckets[0]?.plannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('does not promote the floor when the objective is not fully reserved (even with ample headroom)', () => {
    // Same scenario as the smoking-gun test (need 18 in 8h, headroom 4), but
    // `fullyReserved: false` — the partial-rescue / no-rescue case. Floor must
    // stay at min step; we have no physical guarantee for the higher step.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 18,
        deadlineAtMs: NOW_MS + (8 * HOUR_MS),
        fullyReserved: false,
      }),
      steps: defaultSteps,
      buckets: Array.from({ length: 8 }, (_, i) => bucket(i, 'neutral', { reservedHeadroomKw: 4 })),
    });

    // The climbed-band probe (Slice 1) still picks up that climbing fits
    // — that's the existing behavior — so this is `at_risk`/feasible_above_floor.
    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('feasible_above_floor');
    // Floor itself stayed at min step.
    expect(plan.plannedBuckets[0]?.plannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('is a no-op for single-step devices (the only available step is already the floor)', () => {
    // Single-step EV-style device: the promotion path short-circuits — there is
    // no higher step to promote to. Behavior is identical to pre-Slice-2.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 1,
        deadlineAtMs: NOW_MS + HOUR_MS,
        fullyReserved: true,
      }),
      steps: [{ id: 'one', usefulPowerKw: 1 }],
      buckets: [bucket(0, 'neutral', { reservedHeadroomKw: 4 })],
    });

    expect(plan.status).toBe('on_track');
    expect(plan.plannedBuckets[0]?.plannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('preserves deadline margin before using a preferred bucket inside the reserve window', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
        deadlineMarginMs: HOUR_MS,
      }),
      steps: [
        { id: 'low', usefulPowerKw: 1 },
      ],
      buckets: [
        bucket(0, 'neutral'),
        bucket(1, 'neutral'),
        bucket(2, 'preferred'),
      ],
    });

    expect(plan.status).toBe('on_track');
    expect(plan.usesDeadlineReserve).toBe(false);
    expect(plan.requestedMinimumStepId).toBe('low');
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBe(0);
  });

  it('marks the plan at risk when it must use the deadline reserve', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2.5,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
        deadlineMarginMs: HOUR_MS,
      }),
      steps: [
        { id: 'low', usefulPowerKw: 1 },
      ],
      buckets: [
        bucket(0, 'neutral'),
        bucket(1, 'neutral'),
        bucket(2, 'preferred'),
      ],
    });

    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('planned_using_deadline_reserve');
    expect(plan.usesDeadlineReserve).toBe(true);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBeCloseTo(0.5);
  });

  it('classifies soft avoided-bucket use as risky while hard objectives can remain on track', () => {
    const common = {
      nowMs: NOW_MS,
      steps: [
        { id: 'low', usefulPowerKw: 1 },
      ],
      buckets: [
        bucket(0, 'avoid'),
        bucket(1, 'avoid'),
      ],
    };

    const softPlan = planDeferredObjectiveHorizon({
      ...common,
      objective: objective({ energyNeededKWh: 2, enforcement: 'soft' }),
    });
    const hardPlan = planDeferredObjectiveHorizon({
      ...common,
      objective: objective({ energyNeededKWh: 2, enforcement: 'hard' }),
    });

    expect(softPlan.status).toBe('at_risk');
    expect(softPlan.statusDetail).toBe('planned_using_policy_avoid');
    expect(hardPlan.status).toBe('on_track');
    expect(hardPlan.statusDetail).toBe('planned_with_margin');
  });

  it('uses current avoided capacity when future preferred capacity is not enough', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 1.2, deadlineAtMs: NOW_MS + (2 * HOUR_MS) }),
      steps: [
        { id: 'low', usefulPowerKw: 1 },
      ],
      buckets: [
        bucket(0, 'avoid'),
        bucket(1, 'preferred', { maxUsefulEnergyKWh: 0.4 }),
      ],
    });

    expect(plan.status).toBe('at_risk');
    expect(plan.requestedMinimumStepId).toBe('low');
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(0.4);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(0.8);
  });

  it('scales capped capacity against the original bucket when now clips the current bucket', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS + (HOUR_MS / 2),
      objective: objective({
        energyNeededKWh: 1,
        deadlineAtMs: NOW_MS + HOUR_MS,
      }),
      steps: [
        { id: 'max', usefulPowerKw: 10 },
      ],
      buckets: [
        bucket(0, 'preferred', { maxUsefulEnergyKWh: 1 }),
      ],
    });

    // The per-bucket budget cap (scaled to 0.5 kWh by the now-clip) is the
    // binding constraint — the 10 kW step would deliver far more uncapped — so
    // this is budget-bound at_risk, not a physical cannot_meet. The capacity
    // scaling under test is unchanged.
    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('limited_by_daily_budget');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(0.5);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(0.5);
    expect(plan.currentBucket?.plannedUsefulEnergyKWh).toBeCloseTo(0.5);
    expect(plannedBucket(plan.plannedBuckets, 'h0')?.usefulEnergyCapacityKWh).toBeCloseTo(0.5);
  });

  it('scales split reserve segment capacity against the original bucket when now clips the bucket', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS + (HOUR_MS / 4),
      objective: objective({
        energyNeededKWh: 0.8,
        deadlineAtMs: NOW_MS + HOUR_MS,
        deadlineMarginMs: HOUR_MS / 4,
      }),
      steps: [
        { id: 'max', usefulPowerKw: 10 },
      ],
      buckets: [
        bucket(0, 'preferred', { maxUsefulEnergyKWh: 1 }),
      ],
    });

    // Budget-cap-bound (the 10 kW step is uncapped-feasible), so at_risk, not a
    // physical cannot_meet. The reserve-segment cap scaling under test is
    // unchanged, and the floor still dips into the reserve.
    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('limited_by_daily_budget');
    expect(plan.usesDeadlineReserve).toBe(true);
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(0.75);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(0.05);
    expect(plannedBucket(plan.plannedBuckets, 'h0:primary')?.usefulEnergyCapacityKWh).toBeCloseTo(0.5);
    expect(plannedBucket(plan.plannedBuckets, 'h0:reserve')?.usefulEnergyCapacityKWh).toBeCloseTo(0.25);
  });

  it('reports cannot_meet when all windows at the highest step still miss the target', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 3 }),
      steps: [
        { id: 'low', usefulPowerKw: 1 },
      ],
      buckets: [
        bucket(0, 'preferred'),
        bucket(1, 'preferred'),
      ],
    });

    expect(plan.status).toBe('cannot_meet');
    expect(plan.statusDetail).toBe('target_cannot_be_met');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('does not request charging when the objective is already satisfied', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 0 }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
      ],
    });

    expect(plan.status).toBe('satisfied');
    expect(plan.requestedMinimumStepId).toBeNull();
    expect(plan.plannedBuckets).toEqual([]);
  });

  it('does not report remaining useful energy for sub-epsilon satisfied objectives', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 0.0005 }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
      ],
      epsilonKWh: 0.001,
    });

    expect(plan.status).toBe('satisfied');
    expect(plan.energyNeededKWh).toBeCloseTo(0.0005);
    expect(plan.unplannedUsefulEnergyKWh).toBe(0);
  });
});
