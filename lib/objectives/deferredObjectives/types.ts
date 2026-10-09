export type DeferredObjectiveEnforcement = 'soft' | 'hard';

export type DeferredObjectiveKind =
  | 'ev_soc'
  | 'energy'
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
 * - Exactly one of the two holds per cycle, and it is resolved once. Consumers
 *   (`admission.resolveDecision`, and through its decision
 *   `decorationController.resolveDeferredAvoidDeviceIds`) read it and must not re-derive it from
 *   `currentBucket`, `currentHourFacts` or the status. What a claimed hour promises is a
 *   separate fact, `currentBucket.plannedUsefulEnergyKWh` (0 for a booking without
 *   energy), which admission reads to withhold escalation where nothing is promised.
 * - `claimed` ⇒ the task books the hour (possibly at 0 kWh) and the device should be
 *   driven, on whatever capacity is actually free.
 * - `released` ⇒ the task can finish without the hour. The device is stood down in
 *   its configured release posture.
 * - The fresh and frozen producers answer identically for the same settled state:
 *   the frozen path replays the `:58` settle's persisted booking and
 *   `floorShortfallCause` rather than recomputing them from live inputs.
 *
 * Governing note: `notes/deferred-load-objectives/README.md` § "Booking is decided
 * by price, not by forecast room".
 */
export type DeferredObjectiveCurrentHourClaim = 'claimed' | 'released';

/**
 * Per-cycle facts about the CURRENT hour that the release rules in
 * `resolveCurrentHourClaim` read. Producers state facts here and never a release
 * verdict, so every rule (and every exception to it) lives in that one resolver.
 * Logged beside the resolved claim, so a reader sees what was true and what was
 * decided without the two being able to disagree.
 *
 * Classification only: the active-plan recorder never reads these. It records the
 * committed plan (a price-deferred current hour stays booked as a fallback), so a
 * release never writes a revision; the device's idling (no progress) is what
 * re-books the cheaper hours at the next `:58` settle. See
 * notes/deferred-load-objectives/execution-adaptation.md work item 2.
 */
export type DeferredObjectiveCurrentHourFacts = {
  // The device's measured value is at/above the committed plan's end-of-this-hour
  // milestone in the objective's own unit. Producer-resolved
  // (`isAheadOfHourMilestone`); the planner sees neither the measured value nor
  // the committed rate.
  aheadOfHourMilestone: boolean;
  // A later, booked, non-reserve hour is cheaper than this one by more than the
  // relative margin (`hasCheaperEnergyHourAhead`). The frozen read replays the
  // value the `:58` settle stamped onto the committed hour.
  cheaperHourAhead: boolean;
  // A `temperature` task's full buffered need fits the meaningfully cheaper future
  // hours at its climbed (real-element) step (`resolveColdStartFeasible`). Fresh
  // allocation only: the frozen read cannot prove it and states `false`. See
  // notes/deferred-load-objectives/execution-adaptation.md (cold-start feasibility).
  coldStartFeasible: boolean;
};

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
  // rescue permissions and every higher-ranked load has a booking or a known
  // maximum-step reserve. Together they guarantee the soft daily budget won't cap
  // this device AND lower-priority devices will yield power up to the hard cap
  // — i.e. the higher steps are as reliable as the min step (within the
  // reserved-headroom forecast). When `true`, `resolveStepForBucket`
  // (`horizonPlanner.ts`) promotes the
  // committed floor from `activeSteps[0]` to the highest step the per-bucket
  // `reservedHeadroomKw` forecast supports. The persisted commitment is still
  // physical — only the step it commits to changes.
  fullyReserved: boolean;
  deadlineAtMs: number;
  deadlineMarginMs: number;
};

/**
 * One rung of a device's ladder, as the planner works with it.
 *
 * `usefulPowerKw` is the rate energy lands in the tank/battery/car: the rung's
 * learned power, capped at nameplate, so it sizes bookings and planning speed.
 * `admissionPowerKw` is what the rung may draw from the grid, which is what
 * competes for the hard cap: the rung's NAMEPLATE, the same price the planner's
 * restore admission and startup reserve put on it. Every question that fits a
 * rung into room reads `admissionPowerKw`; every question about energy reads
 * `usefulPowerKw`. For every rung PELS builds, useful is at or below admission,
 * short of it by however far the learned figure trails nameplate.
 *
 * Both are REQUIRED and both are finite and non-negative. That is a producer
 * guarantee, not a hope: `resolveObjectiveSteps` (from a device's profile and
 * calibration view) and `normalizeObjectiveSteps` (from planner input) are the
 * only two ways a step is built, and each resolves `admissionPowerKw`.
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
  // has in this hour: `planningCeilingKw` minus the gross background forecast
  // (`plannedGrossUncontrolledKWh / duration`) minus higher-priority smart-task
  // claims. This stays separate from the net `plannedUncontrolledKWh` daily-budget
  // cap input, because solar can make net background lower than physical
  // background load. `planningCeilingKw` is the lower enabled limit's working
  // rate: `limitKw - marginKw` (the rate the live capacity guard actually
  // admits) while Capacity limit is on, the grid import target while Grid import
  // limit is on. It used to be the RAW configured cap, which made this forecast
  // one safety margin more generous than the runtime, and probed every rung
  // inside that band as reachable. With no power limit enabled there is no
  // ceiling, so the producer omits the forecast.
  //
  // Two consumers, with different fallbacks when it is missing:
  //   - `resolveStepForBucket` (`horizonPlanner.ts`) promotes a FULLY-RESERVED
  //     task's committed floor to the highest rung this forecast admits. No
  //     forecast under a power limit ⇒ the floor stays at the min step: a
  //     commitment may not promise more than the producer has verified. No
  //     power limit at all (`DeferredObjectivePowerLimit` `unlimited`) ⇒ the top
  //     rung: there is no ceiling to verify against, and live control admits it.
  //   - `resolveHighestStepWithinHeadroom` (`stepSelection.ts`) bounds the
  //     feasibility PROBES for every task, fully reserved or not. No forecast ⇒ the
  //     top rung, since nothing physical is known and a probe should not invent a
  //     limit.
  //
  // Optional/backward-compat: missing means "no forecast".
  reservedHeadroomKw?: number;
  // Concurrent DRAW reserved for higher-priority devices in this hour: timed
  // task bookings plus the maximum known steps of higher-ranked devices outside
  // task control. It is the part of `reservedHeadroomKw`'s subtraction that is
  // a real rate rather than an hourly average.
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

/**
 * How the house's enabled power limits bound a smart task's plan, resolved from
 * `PowerLimitSettings` by the policy horizon (`resolveDeferredObjectivePowerLimit`).
 *  - `unlimited`: no power limit is enabled. No hour has a ceiling to forecast,
 *    and live control admits every rung, so a fully reserved task commits its
 *    top rung. This is not "no forecast": nothing is left to verify.
 *  - `limited`: a planning ceiling exists, and each bucket's `reservedHeadroomKw`
 *    forecasts the room under it (absent: the forecast is unavailable).
 *    `admissionCeilingKw` is the grid import target while Grid import limit is
 *    on in a home with no solar production. That limit is instantaneous: with
 *    nothing exporting, live admission never lets a rung drawing above it run,
 *    so the plan books no such rung. `null` with Capacity limit alone, an hourly
 *    average that bounds energy, not any one rung, and `null` in a home with
 *    solar production: live admission spends signed net headroom, so export can
 *    let a rung above the target run, and with no per-hour solar forecast the
 *    plan keeps the whole ladder and leaves that rung to live admission.
 */
export type DeferredObjectivePowerLimit =
  | { kind: 'unlimited' }
  | { kind: 'limited'; admissionCeilingKw: number | null };

export type DeferredObjectiveHorizonInput = {
  nowMs: number;
  objective: DeferredObjective;
  steps: DeferredObjectiveStep[];
  buckets: DeferredObjectiveHorizonBucket[];
  powerLimit: DeferredObjectivePowerLimit;
  // An active zero-hour commitment remains distinct from a fresh allocation.
  // The producer resolves commitment presence before entering the horizon engine.
  commitment:
    | { kind: 'uncommitted' }
    | { kind: 'committed'; hours: DeferredObjectiveCommittedHour[] };
  // Producer-resolved per-cycle trajectory gate (mid-execution price deferral).
  // `true` when the buffered energy still needed is already covered by the
  // committed plan's future hours — i.e. the device is at/above this hour's
  // committed milestone (resolved by `isAheadOfHourMilestone`, which the planner
  // cannot compute itself — it sees neither the measured-driven `energyNeededKWh`
  // nor the commitment). Carried onto `currentHourFacts` for the price-deferral rule.
  aheadOfHourMilestone: boolean;
};

export type DeferredObjectiveCommittedHour = {
  startsAtMs: number;
  plannedKWh: number;
};

// A bucket as the allocator leaves it: its energy, before the plan decides which
// hours it books.
export type DeferredObjectiveAllocatedBucket = {
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

export type DeferredObjectivePlannedBucket = DeferredObjectiveAllocatedBucket & {
  // The plan books this hour (`bookBuckets`). Distinct from its energy: an hour
  // the plan wants on price, or needs because the task falls short, but the
  // forecast left no room for is booked at 0 kWh. It promises nothing, but the
  // task claims it and runs there if capacity turns out to be free.
  booked: boolean;
};

export type DeferredObjectiveCurrentBucketPlan = {
  bucketId: string;
  sourceBucketId: string;
  plannedUsefulEnergyKWh: number;
  booked: boolean;
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
  // The soft daily budget had a hand in this shortfall: with the per-bucket cap
  // lifted, the climbed-band allocation places strictly more energy. Measured
  // between two CLIMBED allocations so the ladder's own contribution is not
  // credited to the budget; not a claim about the floor plan. It says nothing about whether the
  // target is reachable — when lifting the cap CLOSES the gap the status is
  // already `limited_by_daily_budget`, and when it does not the status stays
  // honestly `target_cannot_be_met`. This is the missing half of that second
  // case: the shortfall is not purely physical, so the surface can name the
  // budget and offer the permission that would actually free the device.
  budgetContributedToShortfall: boolean;
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
  // What was true about the current hour this cycle; the release rules read it.
  // See `DeferredObjectiveCurrentHourFacts`.
  currentHourFacts: DeferredObjectiveCurrentHourFacts;
  // What claim this task has on the CURRENT hour, resolved once by the producer
  // (`resolveCurrentHourClaim`) and mapped 1:1 onto an admission decision. Required,
  // deliberately: a new plan producer must answer it rather than inherit a default,
  // because a defaulted claim would either strand a device its task needs or hand
  // the planner one it should hold. Full semantics live on `resolveCurrentHourClaim`
  // in `currentHourClaim.ts`.
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
