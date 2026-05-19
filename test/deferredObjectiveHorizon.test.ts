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

  it('runs the fresh optimizer when committed is false regardless of committedHours', () => {
    // Regression guard: a legacy / non-committed call must route to the fresh
    // optimizer. Same buckets as the previous case but `committed: false`
    // produces a fully on-track plan.
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
    });

    expect(plan.status).toBe('on_track');
    expect(plan.plannedUsefulEnergyKWh).toBeCloseTo(2);
    expect(plan.unplannedUsefulEnergyKWh).toBe(0);
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

    expect(plan.status).toBe('cannot_meet');
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

    expect(plan.status).toBe('cannot_meet');
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
