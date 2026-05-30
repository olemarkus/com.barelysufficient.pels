// Browser-safe contract for the deferred-objective plan-preview estimate.
// Runtime backend produces it; the Settings UI (future PRs) consumes it. Per
// the packaging boundary this file is type-only and imports nothing from
// `lib/`; the status union below mirrors `DeferredObjectiveHorizonStatus` in
// `lib/objectives/deferredObjectives/types` and must stay in sync with it.
//
// IMPORTANT: every numeric field here is an *estimate*. It is computed in
// isolation for a single candidate objective at one instant — it ignores
// future re-plans and competition with other objectives, and is therefore not
// a guarantee.
//
// The divergence has a KNOWN DIRECTION: the estimate assumes the candidate has
// the price bucket's reserved headroom entirely to itself (the backend projects
// it as a single task with no committed sibling plans). When other reserved
// tasks are competing for the same buckets, the live plan may schedule
// fewer/later hours than this shows — so the estimate tends to OVERSTATE
// available headroom and UNDERSTATE `cannot_meet` risk. A UI must therefore
// present this as an estimate, never as a commitment. The runtime doc comment
// on `previewDeferredObjectivePlan` carries the same caveat for backend callers.

import type { DeferredObjectiveSettingsEntry } from './deferredObjectiveSettings.js';

// The candidate objective to project: the same shape the settings store
// persists, minus `enabled` (a preview is implicitly "what would happen if
// this were enabled"). Reusing the settings contract keeps the projection
// wired to the exact fields the planner reads, so there is no separate
// candidate schema to drift. The conditional preserves the discriminated union
// (a bare `Omit<Union, 'enabled'>` would collapse to the common keys and lose
// the per-kind `targetPercent` / `targetTemperatureC`).
export type DeferredObjectivePlanPreviewCandidate =
  DeferredObjectiveSettingsEntry extends infer Entry
    ? Entry extends DeferredObjectiveSettingsEntry
      ? Omit<Entry, 'enabled'>
      : never
    : never;

// Mirror of `DeferredObjectiveHorizonStatus` (lib/objectives/deferredObjectives/types).
// Duplicated because contracts must stay browser-safe and cannot import lib.
export type DeferredObjectivePlanPreviewStatus =
  | 'at_risk'
  | 'cannot_meet'
  | 'invalid'
  | 'on_track'
  | 'satisfied'
  // The candidate could not be projected because the runtime lacked the
  // context the planner needs (no price horizon yet, missing device reading,
  // price-aware optimisation disabled, …). Distinct from `cannot_meet`, which
  // is a real planner verdict that the deadline cannot be met.
  | 'unavailable';

// One scheduled charging hour in the projected plan. `startsAtMs` is an
// hour-aligned UTC timestamp; `plannedKWh` is the energy the planner would
// book into that hour. Shape mirrors `DeferredObjectiveActivePlanHourV1` so a
// preview row renders identically to an active-plan row.
export type DeferredObjectivePlanPreviewHour = {
  startsAtMs: number;
  plannedKWh: number;
};

export type DeferredObjectivePlanPreviewEstimate = {
  // Projected planner verdict for the candidate. `unavailable` means the
  // projection could not run (see the status union doc); the numeric fields
  // below are then all null.
  status: DeferredObjectivePlanPreviewStatus;
  // Hour-aligned charging hours the planner would schedule, ascending by
  // `startsAtMs`. Empty when nothing is scheduled (e.g. already-satisfied,
  // deadline passed, or `unavailable`).
  scheduledHours: DeferredObjectivePlanPreviewHour[];
  // Projected finish/ETA in UTC ms, estimated from the last planned bucket's
  // fill ratio. Null when nothing is scheduled or the projection is
  // `unavailable`.
  projectedFinishAtMs: number | null;
  // Buffered energy (kWh) the planner would book to meet the deadline — the
  // same `mean + k·SE` figure the active-plan recorder persists, rounded to
  // milliWh. Null only when the projection is `unavailable`.
  energyEstimateKWh: number | null;
  // Mean-based energy (kWh) with no variance buffer — the honest "expected"
  // figure paired with `energyEstimateKWh` so a UI can render an
  // `expected…planned` range. Null when there is no buffer to show (cold-start,
  // bootstrap, steady device) or the projection is `unavailable`.
  energyExpectedKWh: number | null;
  // Estimated TOTAL cost = Σ(bucket price × bucket kWh) over the scheduled
  // hours, using the same per-bucket price data the planner's policy horizon
  // consumes. Null when nothing is scheduled, the projection is `unavailable`,
  // or no price was available for the scheduled buckets.
  costEstimate: number | null;
  // Money/amount unit for the TOTAL `costEstimate` — e.g. "øre", "kr", "NOK",
  // or the neutral "price units" fallback. This is deliberately an
  // amount unit, NOT a per-kWh rate ("øre/kWh"): `costEstimate` is a total, so
  // pairing it with a rate label would mislabel the value. Absent when the unit
  // is unknown or `costEstimate` is null.
  costUnit?: string;
};
