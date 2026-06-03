export type DeferredObjectiveEnforcement = 'soft' | 'hard';

export type DeferredObjectiveKind =
  | 'ev_soc'
  | 'generic_energy'
  | 'temperature';

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
  // Raw per-bucket price in the source currency (øre, EUR, eurocent, … — the
  // series carries no unit at this layer; see `collectSnapshotPriceBuckets`).
  // The SOLE price signal: the allocator fills hours cheapest-first by comparing
  // these prices relatively (currency-invariant band, see `bucketAllocation.ts`)
  // and the live deferral compares them by ratio. Optional/back-compat: missing →
  // no price → the hour sorts last in fill order and is non-comparable for
  // deferral.
  price?: number | null;
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
  // Producer-resolved per-cycle trajectory gate (mid-execution price deferral).
  // `true` when the buffered energy still needed is already covered by the
  // committed plan's future hours — i.e. the device is at/above this hour's
  // committed milestone (resolved by `isAheadOfHourMilestone`, which the planner
  // cannot compute itself — it sees neither the measured-driven `energyNeededKWh`
  // nor the commitment). Combined with the relative-price test to set
  // `priceDeferralEligible`. Optional/back-compat: missing → not ahead.
  aheadOfHourMilestone?: boolean;
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
  // Raw per-bucket price carried through from the horizon bucket. Drives the
  // cheapest-first fill order and the relative price-deferral comparison. `null`
  // when the source had no price.
  price: number | null;
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
  // Per-cycle price-deferral control signal (mid-execution price deferral). True
  // when BOTH hold for the current hour: (1) the device's measured value is
  // already at/above the committed plan's end-of-this-hour milestone in the
  // objective's own unit (`aheadOfHourMilestone`), so coasting this hour stays on
  // a deadline-meeting trajectory; and (2) a later, non-reserve hour is cheaper
  // than the current hour by more than the relative margin (raw-price ratio, so
  // unit-invariant across currencies). Read ONLY by the decoration controller's
  // admission path, which idles the device for this cycle so a cheaper hour
  // carries the load. NOT read by the recorder — it records the committed plan
  // (the current hour stays booked as a fallback), so this never writes a
  // revision; the device's idling (no progress) is what re-books the cheaper
  // hours at the next `:58` settle. See
  // notes/deferred-load-objectives/execution-adaptation.md work item 2.
  priceDeferralEligible: boolean;
};
