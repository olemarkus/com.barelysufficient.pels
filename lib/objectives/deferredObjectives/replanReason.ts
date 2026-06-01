import type {
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';

// Internal type matching `DeferredObjectiveDiagnostic`'s shape we need —
// duplicated narrowly to keep this module decoupled from the full diagnostic
// import surface. The recorder owns the full type; the resolver only needs
// the horizon-plan shape to compute the price-up-to value.
type DiagnosticLike = {
  horizonPlan?: { plannedBuckets: ReadonlyArray<{ endMs: number }> } | null;
};

// Latest `bucket.endMs` across the horizon plan. Null when there is no
// horizon (e.g. satisfied objective with `energyNeededKWh === 0`, or
// pending/invalid diagnostic). Used as the "prices were valid through"
// watermark on each revision so the recorder can detect whether a later
// revision actually consumed fresher prices.
export const resolveHorizonPriceWatermark = (
  diag: DiagnosticLike,
): number | null => {
  const horizonPlan = diag.horizonPlan;
  if (!horizonPlan) return null;
  let latest: number | null = null;
  for (const bucket of horizonPlan.plannedBuckets) {
    if (latest === null || bucket.endMs > latest) latest = bucket.endMs;
  }
  return latest;
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
// just below them and ABOVE the generic prices/schedule split so a rate drift
// that also reshapes the schedule is labelled by its root cause rather than the
// resulting schedule change. Otherwise the split between `prices_revised` and
// `schedule_revised` depends on whether the price horizon actually advanced.
export const resolveReplanReason = (params: {
  objectiveChanged: boolean;
  rescuePermissionOnlyChanged: boolean;
  sourceRefined: boolean;
  pricesAdvanced: boolean;
  // The observed delivery speed (calibration-EMA driven) diverged from the
  // committed plan's planning speed. Ranked below the objective/permission/
  // source-refinement causes (which name a stronger, distinct event) but ABOVE
  // the generic prices/schedule split. This ordering is load-bearing: the
  // common slow-delivery case is "rate drifts → planner adds later buckets →
  // schedule changes," so the deviation AND a schedule change frequently fire
  // in the same revision. The deviation is the ROOT CAUSE, so it must win the
  // label — otherwise the most common delivery-driven replan would be
  // mislabelled `schedule_revised` and hide the real reason from the user.
  measuredDeviation: boolean;
}): DeferredObjectiveActivePlanRevisionReason => {
  if (params.rescuePermissionOnlyChanged) return 'flow_permission_changed';
  if (params.objectiveChanged) return 'objective_changed';
  if (params.sourceRefined) return 'rate_refined';
  if (params.measuredDeviation) return 'measured_deviation';
  if (params.pricesAdvanced) return 'prices_revised';
  return 'schedule_revised';
};
