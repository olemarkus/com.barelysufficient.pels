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
  didn't. Its basis is the **original** revision's mean requirement. Using the
  final revision's — which is the energy still OUTSTANDING, and shrinks as a run
  delivers — made the split run backwards: the harder a device fought a real
  capacity limit, the smaller the final remainder and the more likely the
  comparison was to report an estimation error. That shipped, and produced a
  wrong "Target needed more energy than estimated." on a nine-hour EV run that
  was daily-budget-paced throughout (2026-08-11).
- **Telemetry** — the recorder emits one `deferred_objective_history_finalized`
  structured-debug event per observation entry (gated on the
  `deferred_objectives` topic), carrying the cause + raw inputs. Emitted on
  *every* outcome so the met/missed ratio against the same inputs quantifies the
  false-alarm rate. This is the queryable signal Sessions B and C validate
  against.
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
