import type {
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';

// Internal type matching `DeferredObjectiveDiagnostic`'s shape we need —
// duplicated narrowly to keep this module decoupled from the full diagnostic
// import surface. The recorder owns the full type; the resolver only needs
// the horizon-plan shape to compute the price-up-to value. `pricesAvailableUpToMs`
// is the authoritative price-data watermark stamped by the bridge from the SOURCE
// price horizon; `plannedBuckets` is the legacy fallback for diagnostics that
// predate that field (and for the frozen mid-hour read, which carries neither a
// fresh horizon nor the watermark).
type DiagnosticLike = {
  horizonPlan?: {
    plannedBuckets: ReadonlyArray<{ endMs: number }>;
    pricesAvailableUpToMs?: number | null;
  } | null;
};

// The "prices were valid through" watermark for a revision. Prefers
// `horizonPlan.pricesAvailableUpToMs` — the far edge of the AVAILABLE price data
// the bridge stamped from the source price horizon — because the deadline-clamped
// `plannedBuckets` saturate at the deadline once a plan is committed and so can
// never advance even when a fresher Nordpool day publishes (the original
// `schedule_revised` mislabel). Falls back to the latest `bucket.endMs` only when
// the watermark is absent (legacy diagnostic) so existing behaviour is preserved.
// Null when there is no horizon at all (e.g. satisfied objective with
// `energyNeededKWh === 0`, pending/invalid diagnostic, or a frozen read that
// stamped no watermark and booked no buckets).
export const resolveHorizonPriceWatermark = (
  diag: DiagnosticLike,
): number | null => {
  const horizonPlan = diag.horizonPlan;
  if (!horizonPlan) return null;
  const stamped = horizonPlan.pricesAvailableUpToMs;
  if (typeof stamped === 'number' && Number.isFinite(stamped)) return stamped;
  let latest: number | null = null;
  for (const bucket of horizonPlan.plannedBuckets) {
    if (latest === null || bucket.endMs > latest) latest = bucket.endMs;
  }
  return latest;
};

// Resolve the watermark to persist on a revision. The price-availability horizon
// is monotonic non-decreasing for a fixed deadline (prices only ever get
// published further out), so a revision must never DROP it: a frozen mid-hour
// read stamps no watermark (falls back to the deadline-clamped bucket end, which
// is necessarily ≤ the real edge), and a transient prices-missing cycle stamps
// none at all. Taking the max of the freshly-resolved value and the prior
// revision's watermark keeps the carried-forward edge intact so the NEXT genuine
// publish is still detected as an advance (`prices_revised`). `null` only when
// neither side has a value (the first revision before any price data).
export const resolvePersistedPricesUpTo = (
  resolved: number | null,
  previous: number | null | undefined,
): number | null => {
  const prior = typeof previous === 'number' && Number.isFinite(previous) ? previous : null;
  if (resolved === null) return prior;
  if (prior === null) return resolved;
  return Math.max(resolved, prior);
};

// True iff the planner consumed a fresher price horizon than the previous
// revision. `prices_revised` is reserved for this case so the user-visible
// "Tomorrow's prices published" label fires only when Nordpool actually
// published (1–2 times per day). Internal replans surface as
// `schedule_revised`. Requires a strict numeric advance — a null→non-null
// transition is NOT an advance, because the same transition fires when a
// horizon temporarily collapses (e.g. `cannot_meet` with no buckets) and
// then re-emerges with no fresher prices. The intentional copilot finding
// on PR #890 named that mis-labelling.
export const hasPriceHorizonAdvanced = (
  latest: DeferredObjectiveActivePlanRevisionV1,
  diag: DiagnosticLike,
): boolean => {
  const next = resolveHorizonPriceWatermark(diag);
  if (next === null) return false;
  const previous = latest.computedFromPricesUpTo;
  if (previous === null) return false;
  return next > previous;
};

// Pick the recorder-emitted reason from the causes the caller has
// already detected. `flow_permission_changed` wins over generic
// `objective_changed` when the signature differs only in the rescue segment
// (i.e. the user toggled a smart-task rescue Flow card) — the history detail
// then names the Flow permission change instead of the broader
// "smart-task settings / target changed" copy. `objective_changed` and
// `rate_refined` are the next specific named causes; `measured_deviation` ranks
// just below them and ABOVE the generic prices/schedule split so a learned-rate
// drift that also reshapes the schedule is labelled by its root cause rather
// than the resulting schedule change. Otherwise the split between
// `prices_revised` and `schedule_revised` depends on whether the price horizon
// actually advanced.
export const resolveReplanReason = (params: {
  objectiveChanged: boolean;
  rescuePermissionOnlyChanged: boolean;
  sourceRefined: boolean;
  // The live learned per-unit energy rate diverged from the rate the committed
  // plan was built against. The common slow-delivery case is "learned rate
  // drifts → planner adds later buckets → schedule changes", so the deviation
  // and a schedule change frequently fire together; the deviation is the root
  // cause and must win the label over `schedule_revised`.
  measuredDeviation: boolean;
  pricesAdvanced: boolean;
}): DeferredObjectiveActivePlanRevisionReason => {
  if (params.rescuePermissionOnlyChanged) return 'flow_permission_changed';
  if (params.objectiveChanged) return 'objective_changed';
  if (params.sourceRefined) return 'rate_refined';
  if (params.measuredDeviation) return 'measured_deviation';
  if (params.pricesAdvanced) return 'prices_revised';
  return 'schedule_revised';
};
