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
  | 'limited_by_higher_priority_task'
  | 'missing_active_step'
  | 'no_bucket_capacity'
  | 'planned_using_deadline_reserve'
  | 'planned_with_margin'
  | 'target_cannot_be_met';

/**
 * What claim a smart task has on the CURRENT hour.
 *
 * Owned by the plan producers: `horizonPlanner` on the fresh allocation and
 * `frozenHorizonPlan` on the mid-hour read of the commitment, both through the one
 * resolver `resolveCurrentHourClaim` (`currentHourClaim.ts`), which is where the
 * semantics and the cause table live.
 *
 * Invariants a caller may rely on:
 * - Exactly one of the three holds per cycle, and it is resolved once. Consumers
 *   (`admission.resolveDecision`, `decorationController.resolveDeferredAvoidDeviceIds`,
 *   `diagnosticFields.isCurrentBucketPlanned`) read it and must not re-derive it from
 *   `currentBucket.plannedUsefulEnergyKWh`, `priceDeferralEligible` or the status.
 * - `claimed` ⇒ the hour carries booked energy and the device should be driven.
 * - `unclaimed` ⇒ the hour carries NO booked energy and the task cannot finish
 *   without it. The device is neither driven nor stood down: it goes to the planner
 *   as managed and competes on its own priority.
 * - `released` ⇒ the task is not using the hour and can finish anyway. The device is
 *   stood down in its configured release posture.
 * - The fresh and frozen producers answer identically for the same settled state:
 *   the frozen path replays the `:58` settle's persisted `floorShortfallCause`
 *   rather than recomputing sufficiency from the live need.
 *
 * Governing note: `notes/deferred-load-objectives/README.md` § "An unbooked hour is
 * not a stand-down".
 */
export type DeferredObjectiveCurrentHourClaim = 'claimed' | 'released' | 'unclaimed';

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
  // reserved-headroom forecast). When `true`, `resolveStepForBucket`
  // (`horizonPlanner.ts`) promotes the
  // committed floor from `activeSteps[0]` to the highest step the per-bucket
  // `reservedHeadroomKw` forecast supports. The persisted commitment is still
  // physical — only the step it commits to changes. Optional/backward-compat:
  // missing → false → floor stays at min step.
  fullyReserved?: boolean;
  deadlineAtMs: number;
  deadlineMarginMs?: number;
};

/**
 * One rung of a device's ladder, as the planner works with it.
 *
 * `usefulPowerKw` is the rate energy lands in the tank/battery/car;
 * `admissionPowerKw` is what the device draws from the grid, which is what
 * competes for the hard cap. They differ for a device with conversion losses or
 * gain, and are equal for a resistive load.
 *
 * Both are REQUIRED and both are finite and non-negative. That is a producer
 * guarantee, not a hope: `resolveObjectiveSteps` (from a device's calibrated
 * profile) and `normalizeObjectiveSteps` (from planner input) are the only two
 * ways a step is built, and each resolves `admissionPowerKw` — falling back to
 * `usefulPowerKw`, the right default for a resistive load, when no distinct
 * admission calibration exists.
 *
 * It was previously optional "for backward-compatible callers". There were none:
 * both producers always set it, so the fallback ran at all five consumer sites and
 * could never fire, while the type still told each consumer it had to handle
 * absence. Consumers read the field directly.
 */
export type DeferredObjectiveStep = {
  id: string;
  usefulPowerKw: number;
  admissionPowerKw: number;
};

export type DeferredObjectiveHorizonBucket = {
  id: string;
  // Stable id of the unsplit price/budget bucket. Priority coordination may
  // split one source hour at higher-task reservation boundaries so physical
  // power remains exact within each interval; allocation and persisted claims
  // still use this source id for price joins and topology identity.
  sourceBucketId?: string;
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
  // Producer-resolved per-bucket forecast of the physical headroom a smart task
  // has in this hour: hard cap minus the gross background forecast
  // (`plannedGrossUncontrolledKWh / duration`) minus higher-priority smart-task
  // claims. This stays separate from the net `plannedUncontrolledKWh` daily-budget
  // cap input, because solar can make net background lower than physical
  // background load. Note it is built from the RAW configured hard cap, without
  // the capacity safety margin the live guard applies — so it is marginally more
  // generous than what the runtime will actually admit.
  //
  // Two consumers, with different fallbacks when it is missing:
  //   - `resolveStepForBucket` (`horizonPlanner.ts`) promotes a FULLY-RESERVED
  //     task's committed floor to the highest rung this forecast admits. No
  //     forecast ⇒ the floor stays at the min step: a commitment may not promise
  //     more than the producer has verified.
  //   - `resolveHighestStepWithinHeadroom` (`stepSelection.ts`) bounds the
  //     feasibility PROBES for every task, fully reserved or not. No forecast ⇒ the
  //     top rung, since nothing physical is known and a probe should not invent a
  //     limit.
  //
  // Optional/backward-compat: missing means "no forecast".
  reservedHeadroomKw?: number;
  // The concurrent DRAW higher-priority smart tasks have already claimed in this
  // hour, in kW — the part of `reservedHeadroomKw`'s subtraction that is a real
  // rate rather than an hourly average.
  //
  // Kept separate because the two components must be enforced differently. The
  // background term is a forecast AVERAGE (`grossBackgroundKWh / duration`) against
  // an hourly ENERGY allowance, so it bounds how much a device may take, not
  // whether it may run: an hour with 0.86 kW of room holds 0.86 kWh, which a 1.38 kW
  // charger takes in 37 minutes. A higher-priority claim is different in kind — that
  // task really will be drawing that power at the same time — so a rung that does
  // not fit the residual cannot share the hour, and the hour is not the lower task's
  // to plan on. Consumed by `resolveBucketStepCapacityKWh`, which applies the rate
  // test only when this is positive. Optional: absent/zero means no contention.
  higherPriorityAdmissionPowerKw?: number;
  // Higher-priority useful-energy claims retain their actual coverage so a
  // current/deadline-split segment subtracts the overlap after the base hourly
  // budget is prorated, avoiding a second proration of the higher task's kWh.
  higherPriorityEnergyReservations?: ReadonlyArray<{
    startMs: number;
    endMs: number;
    plannedKWh: number;
  }>;
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
  plannedAdmissionPowerKw?: number;
};

export type DeferredObjectiveCurrentBucketPlan = {
  bucketId: string;
  sourceBucketId: string;
  plannedUsefulEnergyKWh: number;
  expectedStepId: string | null;
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
  expectedStepId: string | null;
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
  // Far edge of the AVAILABLE price data this plan was computed against, in epoch
  // ms — the end of the last published price hour that overlaps `[nowMs,
  // deadlineAtMs)` (i.e. `max(priceHorizonEntry.startMs) + 1h`, NOT re-clamped to
  // the deadline beyond the window the price layer already applies). This is the
  // authoritative "prices were valid through" watermark the active-plan recorder
  // compares across revisions to decide whether a later revision genuinely
  // consumed a fresher price publication (`prices_revised`) versus an internal
  // schedule reshuffle (`schedule_revised`). It deliberately does NOT come from
  // `plannedBuckets` (those are deadline-clamped allocator output and saturate at
  // the deadline once a plan is committed, so they can never advance — the
  // original `schedule_revised` mislabel). `null`/absent when no price horizon
  // backed this plan (frozen mid-hour read, prices missing, or price optimization
  // off); the recorder then carries the previous revision's watermark forward
  // (falling back to the legacy bucket-end value only when there is none) rather
  // than resetting it. Optional/back-compat: legacy diagnostics omit it.
  pricesAvailableUpToMs?: number | null;
  // Per-cycle COLD-START price release. True when a later hour is meaningfully
  // cheaper than the current hour AND the full buffered need fits into those
  // cheaper future hours at the device's CLIMBED (real-element) step. The
  // floor-step allocation spills the residual onto an expensive current hour
  // whenever the floor can't fit the whole need, but for a device that can climb
  // that spill is a false premise — the real element will finish in the cheaper
  // window. Read by admission (idles the device this cycle) exactly like
  // `priceDeferralEligible`, but does NOT require the device to be ahead of its
  // milestone (cold start: it is behind). Re-evaluated each cycle. Optional/
  // back-compat: absent ⇒ not released. See
  // notes/deferred-load-objectives/execution-adaptation.md (cold-start feasibility).
  coldStartReleaseEligible?: boolean;
  // What claim this task has on the CURRENT hour, resolved once by the producer
  // (`resolveCurrentHourClaim`) and mapped 1:1 onto an admission decision. Required,
  // deliberately: a new plan producer must answer it rather than inherit a default,
  // because absence would silently mean "unclaimed" and hand the planner a
  // controllable device. Full semantics and the reason the middle state exists live
  // on `resolveCurrentHourClaim` in `currentHourClaim.ts`.
  currentHourClaim: DeferredObjectiveCurrentHourClaim;
  // This plan is a frozen mid-hour projection of the PERSISTED commitment — the
  // allocator did not run (see `buildFrozenHorizonPlan`). It carries no new
  // allocation to settle: its `statusDetail` is a representative placeholder
  // (`FROZEN_STATUS_DETAIL`) and its buckets carry none of the persisted
  // per-hour control stamps, so the active-plan recorder never writes a replan
  // revision from it (`isFrozenServedDiagnostic` gates the settle). Fresh
  // (allocator-run) plans omit it. Optional/back-compat: absent ⇒ fresh.
  frozenRead?: true;
};
