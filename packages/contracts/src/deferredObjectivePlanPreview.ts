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

// One hour on the preview's price curve. `startsAtMs` is an EPOCH-hour-aligned
// UTC timestamp on the SAME basis as `scheduledHours[].startsAtMs`, so the widget
// can join the two by `startsAtMs` and highlight the chosen hours against the
// line. `price` is that hour's per-kWh rate (the same per-bucket price the cost
// estimate sums), or `null` for an interior hour with no published price — the
// series is DENSE (one slot per hour across its span), so a gap is a `null` slot
// the chart breaks the line across, never a dropped element (dropping would skew
// the index-laid-out x-axis). Intentionally carries no `scheduled` flag: the
// widget intersects by `startsAtMs` with `scheduledHours`, keeping this a pure
// price curve with no duplicated state to drift.
export type DeferredObjectivePlanPreviewPricePoint = {
  startsAtMs: number;
  price: number | null;
};

export type DeferredObjectivePlanPreviewEstimate = {
  // Projected planner verdict for the candidate. `unavailable` means the
  // projection could not run (see the status union doc); the numeric fields
  // below are then all null.
  status: DeferredObjectivePlanPreviewStatus;
  // Coarse cause of an `unavailable` projection, so a UI can explain WHY rather
  // than guessing. Present only when `status === 'unavailable'`, and only for the
  // one cause that has bespoke copy: `'needs_observation'` means the device has no
  // learned energy profile yet (e.g. a thermostat PELS has never watched run —
  // there is no temperature bootstrap rate), so PELS must observe it before it can
  // project a plan. Absent for every other `unavailable` cause (genuinely no price
  // horizon, price-aware optimisation off, missing device reading, …), which keeps
  // the generic "no prices published yet" message. Deliberately a single literal,
  // not an open union, to stay lean — add members only when they earn distinct copy.
  unavailableReason?: 'needs_observation';
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
  // Hourly price curve across the preview window (now → deadline), ascending by
  // `startsAtMs`. Lets the widget draw the price line and highlight the
  // `scheduledHours` against it. Absent when no price horizon is available
  // (the projection is then `unavailable`, or has no priced buckets to show).
  // No `priceAxisUnit` is published here: the create-task chart renders the curve
  // as a shape (no y-axis values), so a rate label has nothing to label. Add one
  // when/if the chart grows axis values.
  priceSeries?: DeferredObjectivePlanPreviewPricePoint[];
};
