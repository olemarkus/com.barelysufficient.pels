# Smart-task miss attribution (Session A)

Part of the "Cannot finish / missed streaks don't match reality" investigation.
This note documents the *measurement* step: making each finalized smart-task
run record **why** it got its outcome, so a `missed` can be told apart from a
conservative-planning / shaky-estimate false alarm.

## The problem

A `missed` (or live `cannot_meet`) outcome can come from genuinely different
places, and today they are indistinguishable in the persisted data:

1. **Conservative planning** — the planner sizes feasibility on the lowest
   non-zero step (`planningSpeed.ts`, the only full-hour guarantee), but the
   executor opportunistically climbs higher when capacity allows. A run can be
   flagged "cannot finish" against the floor yet finish in reality.
2. **Shaky learned rate** — early on the `kWhPerUnit` estimate is low-confidence
   and noisy, so "energy needed" (and the verdict) is unreliable.
3. **A genuine capacity miss** — capacity really was too tight; the miss is real.

Without separating these, tuning the planner or the learned rate is guessing.

## What this ships

Plan-time provenance is already captured on the live active plan
(`kwhPerUnitProvenance` = confidence + accepted samples; `initialPlanningSpeedKw`
= committed floor) but was **dropped at finalization**. Session A threads it
through:

- **Contract** — `DeferredObjectivePlanHistoryRevisionSnapshot` gains optional
  `rateConfidence`, `acceptedSamples`, `planningSpeedKw` (v2.7.4). No schema
  bump: v4 **is** released (shipped v2.7.2), and the sanctioned change for a
  released schema is an additive *optional* field — the normalizer filters
  rather than reconstructs, so an older client preserves unknown fields on a
  load→save round-trip. (This line previously read "v4 unreleased", which was
  already wrong when written.) Validated in `planHistorySettings.ts`.
- **Capture** — `captureRevisionSnapshot` (`planHistoryV4Helpers.ts`) pulls them
  from the active plan.
- **Producer** — `packages/shared-domain/src/deferredPlanHistoryAttribution.ts`
  classifies a missed run into one cause. **The producer's own verdict wins**:
  the classifier reads the persisted `floorShortfallCause` — resolved once at
  plan time through `floorShortfallCause.ts` — rather than re-deriving a cause
  from arithmetic. Order: `budget_limited` (via `snapshotShowsBudgetExhausted`,
  which honours both the live cause and the retired count) → `no_delivery` →
  `floorShortfallCause` routing (`time_capacity`/`step_power` →
  `capacity_shortfall`, `estimate` → `low_confidence`) → the
  delivered-vs-committed split → `low_confidence` on a cold start → `unknown`.

  Note `estimate` maps to `low_confidence`, **not** `energy_underestimate`: it
  means the mean rate would have fit and only the `k·SE` padding caused the gap
  — the planner was conservative, the opposite of "the target needed more
  energy than estimated".

  The delivered-vs-committed split (`DELIVERED_PLAN_FRACTION = 0.95`) is
  consulted ONLY where the producer recorded no shortfall, because that is the
  one case its verdict does not cover: the plan said it would make it and it
  didn't. Its basis is the run's committed mean requirement, captured once on
  the entry as `initialEnergyExpectedKWh` (`backfillCommitment` in
  `planHistoryInProgressState.ts`), never a revision's figure. Using the
  final revision's — which is the energy still OUTSTANDING, and shrinks as a run
  delivers — made the split run backwards: the harder a device fought a real
  capacity limit, the smaller the final remainder and the more likely the
  comparison was to report an estimation error. That shipped, and produced a
  wrong "Target needed more energy than estimated." on a nine-hour EV run that
  was daily-budget-paced throughout (2026-08-11).

  The commitment is captured only from a point where nothing has been
  delivered; otherwise the stated requirement is a remainder and the split is
  declined. A run still learning when PELS restarts is saved as `learning` and
  may still capture afterwards, but only while restored plus live delivery is
  zero and its progress has not moved in the task's direction, by at least the
  per-kind no-progress deadband (0.5 °C, 1 %, 0.1 kWh), since the pre-restart
  start reading, because energy delivered while PELS was down is
  never metered. A run saved without a trusted start resumes as unknown, as
  does every row an older build saved (`unknown` rows are not migrated). Before
  this, a restart froze every learning run as unknown, which is how an EV run
  that started ten minutes before a restart finalized with
  `deliveredAtOrAbovePlan: null` (2026-10-01/02).
- **Telemetry** — the recorder emits one `deferred_objective_history_finalized`
  structured-debug event per observation entry (gated on the
  `deferred_objectives` topic), carrying the cause + raw inputs. Emitted on
  *every* outcome so the met/missed ratio against the same inputs quantifies the
  false-alarm rate. This is the queryable signal Sessions B and C validate
  against. Its `plannedKWh` is the sum of each hour's booking at the hour's
  start (`hourStartBookings`), the same schedule the history run bands and
  hourly strip read through `pickScheduledHours`. It includes energy re-booked
  after a short hour (a `:58` re-plan moves an hour's shortfall into later
  hours), so it can exceed the run's need and is never compared with delivery;
  the comparison and the Missed shortfall chip use `initialEnergyExpectedKWh`.
  The final revision's hours cannot stand in: hourly re-plans drop elapsed
  hours, so an overnight EV run once logged `plannedKWh: 0.03` against 29.6 kWh
  delivered. Entries finalized before the per-hour record keep the
  final-revision reading.
- **UI** — the existing single "Why" line (`formatPlanHistoryMissedReason`) is
  *enriched*, not duplicated: a cold-start run reads "Still learning this
  device's energy use.", a delivered-but-short run reads "Target needed more
  energy than estimated.", and a capacity-bound run reads "Not enough available
  power before the deadline." The refinement is inserted ahead of the shipped
  `planStatus` branches; budget copy is checked first and stays unchanged.

  `capacity_shortfall` gained a sentence because without one it fell through to
  the `cannot_meet` line, "Couldn't reserve enough cheap hours in time." — which
  blames the price curve for a run that was capacity- or budget-paced, and reads
  as nonsense on a flat-price night.

## Deliberately out of scope

- The per-sample **rejection-reason histogram** for the learned rate is
  device-profile-level (`objective_profile_sample_recorded` already emits
  rejection events) — it belongs to Session B, not the per-objective history.
- No planner/learned-rate behaviour changes. This is measurement only; Sessions
  B (learned-rate convergence) and C (floor-vs-likely banding) act on what the
  telemetry reveals.
