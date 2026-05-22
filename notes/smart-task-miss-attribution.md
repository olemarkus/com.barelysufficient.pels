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
  `rateConfidence`, `acceptedSamples`, `planningSpeedKw` (v2.7.4; no schema
  bump — v4 unreleased). Validated in `planHistorySettings.ts`.
- **Capture** — `captureRevisionSnapshot` (`planHistoryV4Helpers.ts`) pulls them
  from the active plan.
- **Producer** — `packages/shared-domain/src/deferredPlanHistoryAttribution.ts`
  classifies a missed run into one cause (checked in order):
  `budget_limited` → `low_confidence` → `energy_underestimate` →
  `capacity_shortfall` → `unknown`. `energy_underestimate` vs
  `capacity_shortfall` is the delivered-vs-planned-floor split
  (`DELIVERED_PLAN_FRACTION = 0.95`).
- **Telemetry** — the recorder emits one `deferred_objective_history_finalized`
  structured-debug event per observation entry (gated on the
  `deferred_objectives` topic), carrying the cause + raw inputs. Emitted on
  *every* outcome so the met/missed ratio against the same inputs quantifies the
  false-alarm rate. This is the queryable signal Sessions B and C validate
  against.
- **UI** — the existing single "Why" line (`formatPlanHistoryMissedReason`) is
  *enriched*, not duplicated: a low-confidence `cannot_meet` now reads "PELS was
  still learning this device's energy use (N readings) when it planned this
  run." and a delivered-but-short run reads "Power was available, but the target
  needed more energy than estimated." Shipped budget / cannot_meet copy is
  unchanged; the refinement is inserted ahead of those branches.

## Deliberately out of scope

- The per-sample **rejection-reason histogram** for the learned rate is
  device-profile-level (`objective_profile_sample_recorded` already emits
  rejection events) — it belongs to Session B, not the per-objective history.
- No planner/learned-rate behaviour changes. This is measurement only; Sessions
  B (learned-rate convergence) and C (floor-vs-likely banding) act on what the
  telemetry reveals.
