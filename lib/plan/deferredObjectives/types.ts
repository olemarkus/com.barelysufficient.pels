export type DeferredObjectiveEnforcement = 'soft' | 'hard';

export type DeferredObjectiveKind =
  | 'ev_soc'
  | 'generic_energy'
  | 'temperature';

export type DeferredObjectiveBucketPreference =
  | 'avoid'
  | 'neutral'
  | 'preferred';

export type DeferredObjectiveHorizonStatus =
  | 'at_risk'
  | 'cannot_meet'
  | 'invalid'
  | 'on_track'
  | 'satisfied';

export type DeferredObjectiveHorizonStatusDetail =
  | 'deadline_passed'
  | 'energy_already_met'
  | 'estimate_uncertain'
  | 'feasible_above_floor'
  | 'limited_by_daily_budget'
  | 'invalid_bucket_plan'
  | 'invalid_deadline'
  | 'invalid_energy'
  | 'invalid_now'
  | 'missing_active_step'
  | 'no_bucket_capacity'
  | 'planned_using_deadline_reserve'
  | 'planned_using_policy_avoid'
  | 'planned_with_margin'
  | 'target_cannot_be_met';

export type DeferredObjective = {
  id: string;
  kind: DeferredObjectiveKind;
  enforcement: DeferredObjectiveEnforcement;
  energyNeededKWh: number;
  // Mean-based estimate paired with the buffered `energyNeededKWh`. The
  // difference (`energyNeededKWh − energyExpectedKWh`) is the integrated
  // variance margin (`k·SE`) the producer baked into the plan as a conservative
  // buffer. `resolveStatus` uses it to soften a `cannot_meet` to `at_risk`
  // (`estimate_uncertain`) when the floor's shortfall falls within that margin
  // — i.e. the mean rate would fit and only the buffered padding causes the
  // gap. Optional for backward-compatibility; missing or invalid values
  // collapse the margin to zero so the new branch never fires.
  energyExpectedKWh?: number;
  deadlineAtMs: number;
  deadlineMarginMs?: number;
};

export type DeferredObjectiveStep = {
  id: string;
  usefulPowerKw: number;
};

export type DeferredObjectiveHorizonBucket = {
  id: string;
  startMs: number;
  endMs: number;
  preference?: DeferredObjectiveBucketPreference;
  policyScore?: number;
  maxUsefulEnergyKWh?: number;
};

export type DeferredObjectiveHorizonInput = {
  nowMs: number;
  objective: DeferredObjective;
  steps: DeferredObjectiveStep[];
  buckets: DeferredObjectiveHorizonBucket[];
  // `true` when the producer has an active commitment for this objective —
  // even when the committed hour list is empty (e.g. a `cannot_meet` plan
  // committed zero hours). The horizon planner uses this flag, not
  // `committedHours.length`, to decide between the committed-replan path and
  // the fresh-optimizer path so the two cases stay distinguishable.
  committed?: boolean;
  committedHours?: DeferredObjectiveCommittedHour[];
  epsilonKWh?: number;
};

export type DeferredObjectiveCommittedHour = {
  startsAtMs: number;
  plannedKWh: number;
};

export type DeferredObjectivePlannedBucket = {
  id: string;
  sourceBucketId: string;
  startMs: number;
  endMs: number;
  durationHours: number;
  preference: DeferredObjectiveBucketPreference;
  policyScore: number;
  reserve: boolean;
  current: boolean;
  usefulEnergyCapacityKWh: number;
  plannedUsefulEnergyKWh: number;
};

export type DeferredObjectiveCurrentBucketPlan = {
  bucketId: string;
  sourceBucketId: string;
  plannedUsefulEnergyKWh: number;
  requestedMinimumStepId: string | null;
};

export type DeferredObjectiveHorizonPlan = {
  objectiveId: string;
  kind: DeferredObjectiveKind;
  enforcement: DeferredObjectiveEnforcement;
  status: DeferredObjectiveHorizonStatus;
  statusDetail: DeferredObjectiveHorizonStatusDetail;
  horizonStartMs: number;
  horizonEndMs: number;
  planningEndMs: number;
  deadlineMarginMs: number;
  energyNeededKWh: number;
  plannedUsefulEnergyKWh: number;
  unplannedUsefulEnergyKWh: number;
  requestedMinimumStepId: string | null;
  currentBucket: DeferredObjectiveCurrentBucketPlan | null;
  plannedBuckets: DeferredObjectivePlannedBucket[];
  usesDeadlineReserve: boolean;
  usesPolicyAvoid: boolean;
};
