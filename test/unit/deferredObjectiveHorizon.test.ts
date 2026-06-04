import { planDeferredObjectiveHorizon } from '../../lib/objectives/deferredObjectives';
import type {
  DeferredObjective,
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveStep,
} from '../../lib/objectives/deferredObjectives';

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 0, 1, 17);

const defaultSteps: DeferredObjectiveStep[] = [
  { id: 'off', usefulPowerKw: 0 },
  { id: 'low', usefulPowerKw: 1 },
  { id: 'medium', usefulPowerKw: 2 },
  { id: 'max', usefulPowerKw: 3 },
];

// Relative price tier for a bucket. The allocator fills cheapest-first, so a
// lower price behaves like the old `'preferred'`; these representative values
// keep `preferred < neutral < avoid` ordering so the cheapest-first expectations
// in the fixtures below are unchanged. Pass an explicit `price` in `overrides` to
// override.
const PRICE_BY_TIER = { preferred: 10, neutral: 50, avoid: 100 } as const;
const bucket = (
  hourOffset: number,
  tier: keyof typeof PRICE_BY_TIER = 'neutral',
  overrides: Partial<DeferredObjectiveHorizonBucket> = {},
): DeferredObjectiveHorizonBucket => ({
  id: `h${hourOffset}`,
  startMs: NOW_MS + (hourOffset * HOUR_MS),
  endMs: NOW_MS + ((hourOffset + 1) * HOUR_MS),
  price: PRICE_BY_TIER[tier],
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
    expect(plan.expectedStepId).toBeNull();
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

    // Both hours are needed to fit 2 kWh at the 1 kW low step, so the dearer
    // current hour is booked too — running in a relatively pricier hour is no
    // longer a risk signal; status reflects only feasibility.
    expect(plan.status).toBe('on_track');
    expect(plan.statusDetail).toBe('planned_with_margin');
    expect(plan.expectedStepId).toBe('low');
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
    expect(plan.expectedStepId).toBe('low');
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

    // Honours the committed hours (h0, h2) over the cheaper fresh-optimal h1; the
    // need fits, and running in the dearer committed hours is not a risk signal.
    expect(plan.status).toBe('on_track');
    expect(plan.expectedStepId).toBe('low');
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBe(0);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBeCloseTo(1);
  });

  it('recovers via expansion when committed plan is empty and feasible uncommitted buckets remain', () => {
    // Prod scenario (Connected 300, 2026-05-27 morning shower): a smart task
    // created with current temp already above target gets `committed: true,
    // committedHours: []` because there was nothing to plan. Then a hot-water
    // draw crashes the tank below target mid-task → status flips cannot_meet
    // with a now-positive energyNeededKWh. The previous behaviour treated the
    // empty commitment as a "stale cannot_meet decision must not silently
    // recover" signal and left the task to fail. New behaviour: expansion
    // fires against the remaining horizon and books hours.
    //
    // The current hour (h0) is uncommitted, so expansion fills it cheapest-first
    // like any other hour — the device runs now rather than idling while behind
    // target. A committed current hour would instead be left to phase-1
    // (`committedHourSet` skip); only the uncommitted current hour is filled
    // here. Stability against transient flips comes from the executor's
    // within-hour step climbing (it delivers the committed kWh integral even if
    // a single snapshot looks short) and from the filled current hour
    // self-committing for subsequent cycles.
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

    // Cheapest-first expansion (equal price → ascending time) fills h0 then h1.
    expect(plan.status).toBe('on_track');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBe(0);
  });

  it('reports cannot_meet while still running the only available hour when the target is physically out of reach', () => {
    // Replacement regression for the old "no silent recovery" invariant: the
    // genuinely unrecoverable case is one the horizon physically cannot deliver
    // — here a single hour (deadline NOW+1h) against a need (5 kWh) that exceeds
    // even the top step's one-hour capacity (max = 3 kW → 3 kWh). The task
    // honestly reports cannot_meet AND still runs the available current hour at
    // the floor step (delivering what it can) rather than idling — `cannot_meet`
    // drives the device, see `admission.PLANNABLE_STATUSES`.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 5,
        deadlineAtMs: NOW_MS + HOUR_MS,
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
      ],
      committed: true,
      committedHours: [],
    });

    expect(plan.status).toBe('cannot_meet');
    // The current hour is served at the floor step (1 kWh) instead of stranded.
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(1);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(4);
  });

  it('expansion fills an uncommitted current bucket cheapest-first instead of stranding it', () => {
    // An UNCOMMITTED current bucket has no settled budget to protect, so
    // expansion fills it like any other hour rather than leaving the device off
    // while behind target (the production strand fix — see
    // `bucketAllocation.expandCommittedAllocation`). The cheapest-first sort
    // still defers an expensive current hour behind cheaper future hours, so
    // "wait for a cheaper hour" is preserved; here all hours are equal price so
    // the current hour (h0) is filled first by the ascending-time tiebreak.
    //
    // Setup: current bucket (h0) is preferred and uncommitted. Committed hour is
    // h2. Need exceeds the committed allocation, so expansion books the residual
    // into h0.
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
        { startsAtMs: NOW_MS + (2 * HOUR_MS), plannedKWh: 1 },
      ],
    });

    expect(plan.status).toBe('on_track');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBe(0);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBeCloseTo(1);
  });

  it('expansion never re-claims a COMMITTED current bucket (phase-1 owns its settled budget)', () => {
    // The protected half of the invariant: when the current hour IS committed,
    // its budget is the settled contract for the hour (partial consumption in
    // flight). Phase-1 fills it; expansion must not augment it via the
    // `committedHourSet` skip. Here h0 is the committed current hour at 1 kWh and
    // h1 is an uncommitted future hour. The residual beyond h0's floor capacity
    // spills into h1, never re-claiming h0 beyond its phase-1 fill.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 2,
        deadlineAtMs: NOW_MS + (2 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred'),
        bucket(1, 'preferred'),
      ],
      committed: true,
      committedHours: [
        { startsAtMs: NOW_MS, plannedKWh: 1 },
      ],
    });

    expect(plan.status).toBe('on_track');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    // h0 (committed current) stays at its phase-1 floor fill of 1 kWh; the
    // residual goes to the uncommitted future hour h1, not back into h0.
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
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

  it('does not double-allocate when phase-2 expansion follows phase-1 within a committed hour', () => {
    // Phase-2 expansion still fills *uncommitted* hours only; it must not
    // claim a committed hour a second time after phase-1 already filled it
    // up to step capacity. With 2 kWh need, low-step useful = 1 kW, and a
    // single committed hour h0 (floor: 0.5 kWh), phase-1 fills h0 to bucket
    // step capacity (1 kWh) and phase-2 spills the remaining 1 kWh into
    // h1 — h0 is never visited twice.
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

    // h0 fills to step capacity (1 kWh at low step), not its prior 0.5 floor.
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    // h1 absorbs the remaining 1 kWh via phase-2 expansion.
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
  });

  it('absorbs slow drift into the committed hour up to step capacity without expanding', () => {
    // Production scenario (Connected 300, 2026-05-27 evening task): primary
    // bucket was committed at 0.71 kWh on rev 1; energyNeededKWh climbed to
    // 1.22 kWh over 50 min of natural cooling. Pre-fix, phase-1 capped at
    // 0.71 and phase-2 spilled 0.51 kWh of slivers into 8 future hours,
    // writing 9 schedule_revised revisions in one clock hour. Post-fix,
    // phase-1 fills the committed hour up to step capacity (1 kWh at low
    // step in this test, 1.25 kWh at floor `low` in prod, 2.75 kWh at
    // promoted `max` for fully-reserved tasks). No phase-2 expansion fires;
    // the hour set is unchanged, so the recorder's `sameHourSchedule` gate
    // suppresses revision writes for the drift entirely.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 0.9,
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

    expect(plan.status).toBe('on_track');
    // h0 absorbs all 0.9 kWh (well below the 1 kWh step capacity); no spill.
    // h0 is the COMMITTED current bucket — phase-1 fills it, and phase-2
    // expansion leaves it alone via the `committedHourSet` skip (its settled
    // budget is the contract for the hour). That's what lets drift absorb into
    // the primary committed hour instead of forking into new uncommitted hours.
    // (An *uncommitted* current hour would instead be filled by expansion — see
    // 'expansion fills an uncommitted current bucket cheapest-first…'.)
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(0.9);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBe(0);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBe(0);
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(0.9);
  });

  it('caps the per-hour fill at reservedHeadroomKw × duration when below step capacity', () => {
    // Per-hour ceiling stacks three caps: step capacity, daily-budget
    // pacing slice, and forecast hard-cap headroom. With the floor step
    // at min (low = 1 kW useful) and bucket reservedHeadroomKw at 0.4 kW,
    // the allocator must place at most 0.4 kWh in that hour — committing
    // a full 1 kWh would over-promise against the physical headroom
    // forecast and the executor would hit the hard cap.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 1.5,
        deadlineAtMs: NOW_MS + (3 * HOUR_MS),
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred', { reservedHeadroomKw: 0.4 }),
        bucket(1, 'preferred', { reservedHeadroomKw: 4 }),
        bucket(2, 'preferred', { reservedHeadroomKw: 4 }),
      ],
    });

    // h0 capped at headroom (0.4); h1 fills the residual (1.1) up to its
    // step capacity (1 kWh); h2 absorbs the remainder (0.1).
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(0.4);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBeCloseTo(0.1);
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(1.5);
  });

  it('treats missing reservedHeadroomKw as no headroom cap (back-compat)', () => {
    // Buckets without a `reservedHeadroomKw` forecast (e.g. hardCapKw or
    // backgroundKWh unavailable) must not collapse the per-hour cap to
    // zero. The allocator falls back to step capacity ∧ daily-budget,
    // identical to pre-headroom-cap behavior.
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
    });

    // No headroom cap → each bucket fills to step capacity (1 kWh at low).
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
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

  it('climbs a committed plan up to step capacity when the floor is short', () => {
    // 2 kWh needed in a single 1-hour committed bucket. Floor step `low`
    // (1 kW useful) can only deliver 1 kWh — short by 1 kWh. The climb
    // probe at top step `max` (3 kW useful) fills the same committed hour
    // up to step capacity (3 kWh available) so the energy fits at climb
    // step → verdict softens from cannot_meet to at_risk
    // (feasible_above_floor). Committed kWh is the floor (preserved by the
    // recorder's merge), not a per-hour ceiling on phase-1/climb fills.
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

    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('feasible_above_floor');
    // Floor still allocates 1 kWh of useful energy in the committed bucket;
    // the remaining 1 kWh is what the climb step would need to deliver.
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(1);
  });

  it('keeps cannot_meet when even the climb step cannot fit the need into the committed horizon', () => {
    // 4 kWh needed in a single 1-hour committed bucket. Floor `low` (1 kWh
    // capacity) delivers 1 kWh; climb step `max` (3 kWh capacity) still
    // leaves 1 kWh unplanned — no future hours to expand into. Verdict
    // stays cannot_meet. The single-bucket horizon isolates this from the
    // committed-plan-expansion path.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 4,
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
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(3);
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

  it('caps each bucket at reservedHeadroomKw × duration when forecast headroom is below the floor step', () => {
    // headroom = 0.5 — less than min step (1 kW). Promotion picks the
    // rightmost step that fits, defaulting to the min step when even it
    // doesn't. With the per-hour cap honouring reservedHeadroomKw, each
    // bucket can place only 0.5 kWh — the executor would breach the hard
    // cap if we committed a full 1 kWh and reality only had 0.5 kW of
    // hard-cap headroom. Need 4 kWh in 4h → 4 × 0.5 = 2 kWh placed, 2 kWh
    // unplanned; even climb at max=3 stays capped at 0.5 → cannot_meet.
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

    expect(plan.status).toBe('cannot_meet');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plan.plannedBuckets[0]?.plannedUsefulEnergyKWh).toBeCloseTo(0.5);
    expect(plan.unplannedUsefulEnergyKWh).toBeCloseTo(2);
  });

  it('promotes generous-headroom buckets to higher steps while tight-headroom buckets stay at min step', () => {
    // 7 generous buckets (headroom 4) + 1 tight (headroom 0.5). Per-bucket
    // promotion: generous buckets commit at the highest active step that
    // fits 4 kW = `max` (3 kW); the tight bucket has no step that fits 0.5
    // kW (even low = 1 kW exceeds it), so it falls back to `activeSteps[0]`
    // = low. Per-hour cap then enforces the actual per-bucket headroom on
    // top: generous buckets place min(3, ∞, 4) = 3 kWh; tight bucket places
    // min(1, ∞, 0.5) = 0.5 kWh. 7 × 3 + 0.5 = 21.5 kWh capacity against 18
    // kWh need → on_track. (Pre-per-bucket behaviour: a single tight bucket
    // held the whole horizon to min step and the task degraded to at_risk;
    // per-bucket promotion eliminates that pessimism.)
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

    expect(plan.status).toBe('on_track');
    // Tight bucket (h2) capped at headroom = 0.5 kWh.
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h2')).toBeCloseTo(0.5);
    // Generous bucket (h0) gets the full max-step capacity = 3 kWh.
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(3);
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(18);
  });

  it('promotes per bucket independently — buckets without a forecast stay at min step, others promote', () => {
    // Two buckets carry headroom = 4; one is missing the forecast field.
    // Per-bucket promotion: forecasted buckets land at `max` (3 kW useful,
    // capped to headroom 4 kW = 3 kWh/h); the bucket without a forecast
    // falls back to `activeSteps[0]` = low (1 kWh/h). 3 + 1 + 3 = 7 kWh
    // floor capacity against 8 kWh need → 1 kWh shortfall. Climb probe
    // (uniform max=3) gets 3 × 3 = 9 kWh, fits → at_risk/feasible_above_floor.
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
        bucket(1, 'neutral'), // no reservedHeadroomKw — stays at min step
        bucket(2, 'neutral', { reservedHeadroomKw: 4 }),
      ],
    });

    expect(plan.status).toBe('at_risk');
    expect(plan.statusDetail).toBe('feasible_above_floor');
    // Forecasted bucket promoted to max-step capacity.
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(3);
    // Bucket without forecast holds at min step.
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h1')).toBeCloseTo(1);
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

  it('current-bucket expectedStepId reflects planned kWh, not the promoted floor-step ceiling', () => {
    // Per-bucket promotion can put a generous bucket at `max` step capacity
    // (e.g. 3 kWh available in 1 h), but the planner may only NEED to fill
    // a small slice of that capacity (e.g. 0.3 kWh in the current hour to
    // hit the target on time). The executor's `expectedStepId`
    // must reflect what the executor actually needs to run NOW — the
    // smallest step that fits the planned kWh — not the promoted ceiling.
    // Otherwise the executor would over-climb and trip the hard cap.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({
        energyNeededKWh: 0.3,
        deadlineAtMs: NOW_MS + (2 * HOUR_MS),
        fullyReserved: true,
      }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'preferred', { reservedHeadroomKw: 4 }),
        bucket(1, 'preferred', { reservedHeadroomKw: 4 }),
      ],
    });

    // Current bucket has 0.3 kWh of work — low step (1 kW × 1 h = 1 kWh)
    // covers that comfortably, so the executor only needs to run at low.
    // The PER-BUCKET PROMOTION (max @ 3 kW useful) is a CEILING for the
    // commitment, not a floor for the executor's setpoint.
    expect(plan.expectedStepId).toBe('low');
    expect(plan.currentBucket?.expectedStepId).toBe('low');
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
    expect(plan.expectedStepId).toBe('low');
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

  it('stays on_track when running in relatively expensive hours — price tier is not a risk signal', () => {
    // Both remaining hours are the dearest available, and the need fits in them.
    // `at_risk` means only "the objective might not be met"; being scheduled into
    // comparatively pricier hours is not a risk, so neither soft nor hard flips.
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

    expect(softPlan.status).toBe('on_track');
    expect(softPlan.statusDetail).toBe('planned_with_margin');
    expect(hardPlan.status).toBe('on_track');
    expect(hardPlan.statusDetail).toBe('planned_with_margin');
  });

  it('uses current dearer capacity when the cheaper future hour cannot hold the whole need', () => {
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

    // The cheap hour caps at 0.4 kWh, so the remaining 0.8 kWh comes from the
    // dearer current hour. The need still fits before the deadline → on_track.
    expect(plan.status).toBe('on_track');
    expect(plan.expectedStepId).toBe('low');
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
    expect(plan.expectedStepId).toBeNull();
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

  // Mid-execution price deferral: the planner combines the producer-resolved
  // `aheadOfHourMilestone` trajectory gate with a relative raw-price test. The
  // current hour stays booked by the commitment floor; eligibility means the
  // admission path idles the device this cycle so a cheaper later hour carries
  // the load. (Trajectory math itself is covered in trajectoryMilestone.test.ts.)
  const deferralBuckets = (prices: number[]): DeferredObjectiveHorizonBucket[] => (
    prices.map((price, hourOffset) => bucket(hourOffset, 'neutral', { price }))
  );

  it('flags priceDeferralEligible when ahead of milestone and a later hour is >5% cheaper', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 2 }), // deadline NOW + 4h
      steps: defaultSteps,
      buckets: deferralBuckets([100, 90, 90, 90]),
      committed: true,
      committedHours: [{ startsAtMs: NOW_MS, plannedKWh: 1 }],
      aheadOfHourMilestone: true,
    });

    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeCloseTo(1);
    expect(plan.priceDeferralEligible).toBe(true);
  });

  it('does not flag priceDeferralEligible when not ahead of the milestone', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 2 }),
      steps: defaultSteps,
      buckets: deferralBuckets([100, 50, 50, 50]),
      committed: true,
      committedHours: [{ startsAtMs: NOW_MS, plannedKWh: 1 }],
      aheadOfHourMilestone: false,
    });

    expect(plan.priceDeferralEligible).toBe(false);
  });

  it('does not flag priceDeferralEligible when no later hour beats the 5% margin', () => {
    // Later hours are cheaper, but only by <5% (current 100, threshold 95;
    // later hours 96/98) — keep the safer earlier slot.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 2 }),
      steps: defaultSteps,
      buckets: deferralBuckets([100, 96, 98, 97]),
      committed: true,
      committedHours: [{ startsAtMs: NOW_MS, plannedKWh: 1 }],
      aheadOfHourMilestone: true,
    });

    expect(plan.priceDeferralEligible).toBe(false);
  });

  it('does not defer into the deadline-reserve hour even when it is cheaper', () => {
    // deadlineMarginMs = 1h ⇒ h3 (NOW+3h..NOW+4h) is the reserve segment. The
    // only sub-threshold hour is that reserve hour, so eligibility is false.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 2, deadlineMarginMs: HOUR_MS }),
      steps: defaultSteps,
      buckets: deferralBuckets([100, 100, 100, 50]),
      committed: true,
      committedHours: [{ startsAtMs: NOW_MS, plannedKWh: 1 }],
      aheadOfHourMilestone: true,
    });

    expect(plan.priceDeferralEligible).toBe(false);
  });

  it('does not flag priceDeferralEligible when the current hour price is free or negative', () => {
    // current ≤ 0 ⇒ heat now while it is free; never defer away from it.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 2 }),
      steps: defaultSteps,
      buckets: deferralBuckets([0, -5, -5, -5]),
      committed: true,
      committedHours: [{ startsAtMs: NOW_MS, plannedKWh: 1 }],
      aheadOfHourMilestone: true,
    });

    expect(plan.priceDeferralEligible).toBe(false);
  });

  it('flags priceDeferralEligible when a later hour has a negative price', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 2 }),
      steps: defaultSteps,
      buckets: deferralBuckets([100, -2, 100, 100]),
      committed: true,
      committedHours: [{ startsAtMs: NOW_MS, plannedKWh: 1 }],
      aheadOfHourMilestone: true,
    });

    expect(plan.priceDeferralEligible).toBe(true);
  });

  it('does not flag priceDeferralEligible when the only cheaper later hour carries no booked load', () => {
    // h1 is cheaper but capped to zero by its daily-budget/headroom forecast, so
    // the allocation books nothing into it — it won't carry the deferred load, and
    // releasing toward it would just push the load into the pricier committed
    // hours. No other hour beats the margin.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 2 }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'neutral', { price: 100 }),
        bucket(1, 'neutral', { price: 50, maxUsefulEnergyKWh: 0 }),
        bucket(2, 'neutral', { price: 100 }),
        bucket(3, 'neutral', { price: 100 }),
      ],
      committed: true,
      committedHours: [{ startsAtMs: NOW_MS, plannedKWh: 1 }],
      aheadOfHourMilestone: true,
    });

    expect(plan.priceDeferralEligible).toBe(false);
  });

  it('does not flag priceDeferralEligible when the current hour carries no booked energy', () => {
    // No commitment + the current hour is less preferred, so the allocator books
    // the preferred future hour and leaves the current hour at 0 kWh — it is
    // already idle, so there is nothing to defer.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ energyNeededKWh: 1 }),
      steps: defaultSteps,
      buckets: [
        bucket(0, 'avoid', { price: 100 }),
        bucket(1, 'preferred', { price: 50 }),
        bucket(2, 'preferred', { price: 50 }),
      ],
      aheadOfHourMilestone: true,
    });

    expect(plan.currentBucket?.plannedUsefulEnergyKWh ?? 0).toBe(0);
    expect(plan.priceDeferralEligible).toBe(false);
  });

  // Cold-start release: the floor step (low = 1 kW) can't fit the need, so the
  // cheapest-first allocator spills the residual onto the expensive current hour
  // — but the device can climb (max = 3 kW) and the meaningfully-cheaper future
  // hours cover the FULL need at that step, so the current hour is released.
  // defaultSteps = off/low(1)/medium(2)/max(3); PRICE_BY_TIER avoid=100, preferred=10.
  it('flags coldStartReleaseEligible: expensive current hour, need fits the cheaper future at the climbed step', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ kind: 'temperature', energyNeededKWh: 5 }), // > floor capacity (4h × 1 kW), ≤ climb in 3 cheap hours (3 × 3)
      steps: defaultSteps,
      buckets: [bucket(0, 'avoid'), bucket(1, 'preferred'), bucket(2, 'preferred'), bucket(3, 'preferred')],
      committed: false,
    });

    // The floor allocation DID spill onto the expensive current hour (the false premise)…
    expect(plannedBySourceBucket(plan.plannedBuckets, 'h0')).toBeGreaterThan(0);
    // …but the cold-start release fires so admission idles it.
    expect(plan.coldStartReleaseEligible).toBe(true);
  });

  it('does not flag coldStartReleaseEligible when no future hour is meaningfully cheaper than now', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ kind: 'temperature', energyNeededKWh: 5 }),
      steps: defaultSteps,
      // Current hour is the cheapest; later hours are dearer → nothing to defer toward.
      buckets: [bucket(0, 'preferred'), bucket(1, 'avoid'), bucket(2, 'avoid'), bucket(3, 'avoid')],
      committed: false,
    });

    expect(plan.coldStartReleaseEligible ?? false).toBe(false);
  });

  it('does not flag coldStartReleaseEligible when the cheaper future cannot cover the need even at the climbed step', () => {
    // Only one cheaper future hour (h1) at max 3 kW = 3 kWh < 5 kWh need → the
    // expensive current hour is genuinely needed, so do not release it.
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ kind: 'temperature', energyNeededKWh: 5, deadlineAtMs: NOW_MS + (2 * HOUR_MS) }),
      steps: defaultSteps,
      buckets: [bucket(0, 'avoid'), bucket(1, 'preferred')],
      committed: false,
    });

    expect(plan.coldStartReleaseEligible ?? false).toBe(false);
  });

  it('does not flag coldStartReleaseEligible for a single-step device (no climb capacity)', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ kind: 'temperature', energyNeededKWh: 5 }),
      steps: [{ id: 'off', usefulPowerKw: 0 }, { id: 'low', usefulPowerKw: 1 }],
      buckets: [bucket(0, 'avoid'), bucket(1, 'preferred'), bucket(2, 'preferred'), bucket(3, 'preferred')],
      committed: false,
    });

    expect(plan.coldStartReleaseEligible ?? false).toBe(false);
  });

  it('does not flag coldStartReleaseEligible when the current hour is free or negative', () => {
    const plan = planDeferredObjectiveHorizon({
      nowMs: NOW_MS,
      objective: objective({ kind: 'temperature', energyNeededKWh: 5 }),
      steps: defaultSteps,
      buckets: [bucket(0, 'avoid', { price: 0 }), bucket(1, 'preferred'), bucket(2, 'preferred'), bucket(3, 'preferred')],
      committed: false,
    });

    expect(plan.coldStartReleaseEligible ?? false).toBe(false);
  });
});
