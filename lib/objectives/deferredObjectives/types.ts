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
  // Producer-resolved flat boolean: `true` iff the objective holds BOTH the
  // `exemptFromBudget === 'always'` AND `limitLowerPriorityDevices === 'always'`
  // rescue permissions. Together they guarantee the soft daily budget won't cap
  // this device AND lower-priority devices will yield power up to the hard cap
  // — i.e. the higher steps are as reliable as the min step (within the
  // reserved-headroom forecast). When `true`, `resolveFloorStep` promotes the
  // committed floor from `activeSteps[0]` to the highest step the per-bucket
  // `reservedHeadroomKw` forecast supports. The persisted commitment is still
  // physical — only the step it commits to changes. Optional/backward-compat:
  // missing → false → floor stays at min step.
  fullyReserved?: boolean;
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
  // Producer-resolved per-bucket forecast of physical headroom available to a
  // fully-reserved smart task: `hardCapKw − plannedUncontrolledKw` (the hard
  // cap minus the forecast non-PELS-managed load, since a fully-reserved task
  // can displace lower-priority controlled devices up to the cap). Consumed by
  // `resolveFloorStep` to promote the committed floor when the objective is
  // fully reserved. Optional/backward-compat: missing means "no forecast" and
  // the floor stays at min step.
  reservedHeadroomKw?: number;
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
  // Per-cycle price-deferral control signal (mid-execution price deferral). True
  // when the current hour is an `avoid` (expensive) hour carrying booked energy
  // purely because of the commitment floor, AND re-allocating the buffered-floor
  // residual over the remaining (cheaper, non-`avoid`) hours alone still lands
  // `on_track`. Read ONLY by the decoration controller's admission path, which
  // idles the device for this cycle so a cheaper hour carries the load. NOT read
  // by the recorder — it records the committed plan (the `avoid` hour stays booked
  // as a fallback), so this never writes a revision; the device's idling (no
  // progress) is what re-books the cheaper hours at the next `:58` settle. See
  // notes/deferred-load-objectives/execution-adaptation.md work item 2.
  priceDeferralEligible: boolean;
};
