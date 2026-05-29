// Miss-attribution producer for finalized smart-task history entries
// (Session A of the "Cannot finish / missed streaks don't match reality"
// investigation — see notes/smart-task-miss-attribution.md).
//
// The problem this solves: a `missed` outcome can come from genuinely
// different places — the daily budget cap blocked hours, the learned rate was
// too shaky to trust, the executor delivered the planned power but the target
// needed more energy than estimated, or capacity really did stay too tight.
// Today those look identical in the data, so we can't tell a real miss from a
// conservative-planning / shaky-estimate false alarm. This producer reads the
// plan-time provenance now persisted on the revision snapshot
// (`rateConfidence`, `acceptedSamples`, `planningSpeedKw`) plus the recorded
// delivery and classifies the cause, so the runtime can log a per-run
// attribution and the history-detail page can show a single plain cause line.
//
// Per `feedback_layering_resolution_in_producer.md` every visible string and
// the classification itself are resolved here; the view layer only renders,
// and the runtime emitter only forwards the resolved fields. The same helper
// backs both surfaces so the logged cause and the user-visible line never
// disagree.

import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../contracts/src/deferredObjectivePlanHistory';

// Why a `missed` run missed, in the order we check (most concrete cause wins):
//   - `budget_limited`     — the daily budget cap collapsed one or more planned
//                            hours; the device was held back on purpose.
//   - `low_confidence`     — the learned rate backing the plan was still in its
//                            low-confidence band, so the "cannot finish" rested
//                            on a shaky estimate (false-alarm-suspect).
//   - `energy_underestimate` — the executor delivered at/above the planned
//                            floor energy yet still missed: capacity was there,
//                            but the target needed more energy than estimated.
//   - `capacity_shortfall` — confident plan, but the executor couldn't deliver
//                            even the planned floor; a genuine capacity miss.
//   - `unknown`            — not enough recorded data to attribute honestly.
export type DeferredPlanHistoryMissCause =
  | 'budget_limited'
  | 'low_confidence'
  | 'energy_underestimate'
  | 'capacity_shortfall'
  | 'unknown';

// Fraction of the planned floor energy the executor must have delivered for a
// miss to read as an energy-needed underestimate rather than a capacity
// shortfall. 0.95 tolerates rounding and the last partial hour without letting
// a clear under-delivery masquerade as "power was available".
const DELIVERED_PLAN_FRACTION = 0.95;

type AttributionSnapshot = Pick<
  DeferredObjectivePlanHistoryRevisionSnapshot,
  'hours' | 'planStatus' | 'rateConfidence' | 'acceptedSamples'
  | 'planningSpeedKw' | 'dailyBudgetExhaustedBucketCount' | 'energyExpectedKWh'
>;

const sumPlannedKWh = (snapshot: AttributionSnapshot): number => {
  let total = 0;
  for (const hour of snapshot.hours) {
    if (Number.isFinite(hour.plannedKWh) && hour.plannedKWh > 0) total += hour.plannedKWh;
  }
  return total;
};

// Resolved attribution for a finalized run. `cause` is null on outcomes other
// than `missed` (a met / abandoned / replaced / unknown run has nothing to
// attribute) and on missed runs we still couldn't classify. The remaining
// fields are the raw inputs the classification rested on, surfaced so the
// runtime structured log can correlate causes across runs without re-deriving.
export type DeferredPlanHistoryMissAttribution = {
  cause: DeferredPlanHistoryMissCause | null;
  plannedKWh: number | null;
  deliveredKWh: number | null;
  planningSpeedKw: number | null;
  rateConfidence: 'low' | 'medium' | 'high' | null;
  acceptedSamples: number | null;
  dailyBudgetExhaustedBucketCount: number;
  // True when the executor delivered at/above the planned floor energy. Null
  // when delivery or the planned total wasn't recorded. Drives the
  // energy-underestimate vs capacity-shortfall split.
  deliveredAtOrAbovePlan: boolean | null;
};

const pickSnapshot = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'finalPlan' | 'originalPlan'>,
): AttributionSnapshot | null => entry.finalPlan ?? entry.originalPlan ?? null;

const resolveCause = (params: {
  outcome: DeferredObjectivePlanHistoryEntry['outcome'];
  snapshot: AttributionSnapshot | null;
  deliveredAtOrAbovePlan: boolean | null;
}): DeferredPlanHistoryMissCause | null => {
  const { outcome, snapshot, deliveredAtOrAbovePlan } = params;
  if (outcome !== 'missed') return null;
  if (snapshot === null) return 'unknown';
  if ((snapshot.dailyBudgetExhaustedBucketCount ?? 0) > 0) return 'budget_limited';
  // A shaky estimate undercuts the whole verdict, so it outranks the
  // delivered-vs-planned split below — that split assumes the plan it's
  // measuring against was trustworthy.
  if (snapshot.rateConfidence === 'low') return 'low_confidence';
  if (deliveredAtOrAbovePlan === true) return 'energy_underestimate';
  if (deliveredAtOrAbovePlan === false) return 'capacity_shortfall';
  return 'unknown';
};

const resolveDeliveredKWh = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'deliveredKWh'>,
): number | null => (
  typeof entry.deliveredKWh === 'number' && Number.isFinite(entry.deliveredKWh)
    ? entry.deliveredKWh
    : null
);

// Narrows an optional `energyExpectedKWh` hint to a positive finite number
// (the only shape the comparison can act on); other shapes collapse to null
// so the comparison falls back to the buffered `plannedKWh` sum. Accepts
// `undefined` from the optional snapshot field as well as `null` from legacy
// call sites that explicitly pass "no hint".
const normalizeEnergyExpectedKWh = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
};

// Snapshot wins over the optional argument — once the producer has persisted
// the mean onto the snapshot, that's the authoritative value for both runtime
// and UI render paths. The hint argument remains useful for call sites that
// resolve the attribution from the in-flight runtime value before the snapshot
// has been assembled (e.g. tests, callers that bypass `pushEntry`).
const pickResolvedMean = (
  snapshot: AttributionSnapshot | null,
  hint: number | null,
): number | null => (
  normalizeEnergyExpectedKWh(snapshot?.energyExpectedKWh)
  ?? normalizeEnergyExpectedKWh(hint)
);

const resolveDeliveredAtOrAbovePlan = (
  deliveredKWh: number | null,
  plannedKWh: number | null,
  // Mean-based attribution avoids labelling a cold-start buffer-inflated run as
  // `capacity_shortfall` when delivered energy actually met the underlying mean
  // estimate. When the caller doesn't have the mean (legacy UI render of a
  // historical entry), fall back to the buffered `plannedKWh` — same behaviour
  // as before this fix.
  energyExpectedKWh: number | null,
): boolean | null => {
  const comparisonBasis = energyExpectedKWh ?? plannedKWh;
  if (deliveredKWh === null || comparisonBasis === null || comparisonBasis <= 0) return null;
  return deliveredKWh >= comparisonBasis * DELIVERED_PLAN_FRACTION;
};

/**
 * Resolves the miss attribution for a finalized history entry. Pure and
 * browser-safe: reads the persisted entry (including the snapshot's persisted
 * `energyExpectedKWh` when present) plus an optional mean-energy hint the
 * runtime emitter threads from the live revision at finalize time. Returns a
 * fully-populated structure on every call (fields null when their input wasn't
 * recorded) so the runtime structured log can forward it verbatim and the UI
 * helper can read `cause` without re-deriving.
 *
 * `energyExpectedKWh` (the second argument) is the mean-based plan total
 * (no variance buffer), threaded from the live
 * `DeferredObjectiveActivePlanRevisionV1.energyExpectedKWh` at finalization.
 * The snapshot's persisted `energyExpectedKWh` (written by the recorder during
 * the same finalize pass) is the source of truth at read time so both runtime
 * and UI now resolve identical `missCause` values; the hint is retained for
 * call sites that have the live value but haven't yet flowed through
 * persistence. When neither is present (legacy entries written before this
 * field shipped, backfill entries) the comparison falls back to the buffered
 * `plannedKWh` sum — same behaviour as before the fix, so UI-side attribution
 * of historical entries is no-worse-than-before.
 */
export const resolveDeferredPlanHistoryMissAttribution = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'outcome' | 'deliveredKWh' | 'finalPlan' | 'originalPlan'
  >,
  energyExpectedKWh: number | null = null,
): DeferredPlanHistoryMissAttribution => {
  const snapshot = pickSnapshot(entry);
  const plannedTotal = snapshot === null ? null : sumPlannedKWh(snapshot);
  const plannedKWh = plannedTotal !== null && plannedTotal > 0 ? plannedTotal : null;
  const deliveredKWh = resolveDeliveredKWh(entry);
  const deliveredAtOrAbovePlan = resolveDeliveredAtOrAbovePlan(
    deliveredKWh,
    plannedKWh,
    pickResolvedMean(snapshot, energyExpectedKWh),
  );
  return {
    cause: resolveCause({ outcome: entry.outcome, snapshot, deliveredAtOrAbovePlan }),
    plannedKWh,
    deliveredKWh,
    planningSpeedKw: snapshot?.planningSpeedKw ?? null,
    rateConfidence: snapshot?.rateConfidence ?? null,
    acceptedSamples: snapshot?.acceptedSamples ?? null,
    dailyBudgetExhaustedBucketCount: snapshot?.dailyBudgetExhaustedBucketCount ?? 0,
    deliveredAtOrAbovePlan,
  };
};

const formatLowConfidenceCause = (acceptedSamples: number | null): string => {
  // Reuses the "what PELS has learned" framing from the live confidence surface
  // so the receipt reads as the same story the user saw while the task ran under
  // the "Estimating" chip. Kept tight (no "PELS was…" / "…when it planned this
  // run") so it fits the one-line list-card reason slot at 320px; the consumer
  // prefixes "Why:" which supplies the subject.
  if (acceptedSamples !== null && acceptedSamples > 0) {
    const readings = `${acceptedSamples} ${acceptedSamples === 1 ? 'reading' : 'readings'}`;
    return `Still learning this device's energy use (${readings}).`;
  }
  return "Still learning this device's energy use.";
};

/**
 * Composes the "Why" sentence for the two miss causes that only the plan-time
 * provenance (Session A) can distinguish — a low-confidence learned rate, and
 * a run that delivered the planned power yet still came up short because the
 * target needed more energy than estimated. Returns `null` for every other
 * cause (`budget_limited`, `capacity_shortfall`, `unknown`) and for non-missed
 * outcomes.
 *
 * Deliberately narrow: the shipped budget-exhaustion and `cannot_meet` "Why"
 * copy stays owned by `formatPlanHistoryMissedReason`'s `planStatus` branches
 * so this change doesn't reword strings the UI already ships. The caller
 * inserts this refinement ahead of those branches, so a low-confidence
 * `cannot_meet` reads "still learning" rather than "couldn't reserve enough
 * cheap hours". Tone matches the surrounding blameless receipt copy.
 */
export const formatRefinedMissCause = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'outcome' | 'deliveredKWh' | 'finalPlan' | 'originalPlan'
  >,
): string | null => {
  const attribution = resolveDeferredPlanHistoryMissAttribution(entry);
  switch (attribution.cause) {
    case 'low_confidence':
      return formatLowConfidenceCause(attribution.acceptedSamples);
    case 'energy_underestimate':
      return 'Target needed more energy than estimated.';
    default:
      return null;
  }
};
