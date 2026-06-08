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
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../contracts/src/deferredObjectivePlanHistory';
import { MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP } from './deadlineLabels';

// Why a `missed` run missed, in the order we check (most concrete cause wins):
//   - `budget_limited`     — the daily budget cap collapsed one or more planned
//                            hours; the device was held back on purpose.
//   - `no_delivery`        — the device delivered essentially no useful energy
//                            and made no progress toward target; the most
//                            concrete, device-actionable miss.
//   - `capacity_shortfall` — confident plan, but the executor couldn't deliver
//                            even the planned floor; a genuine capacity miss.
//   - `energy_underestimate` — the executor delivered at/above the planned
//                            floor energy yet still missed: capacity was there,
//                            but the target needed more energy than estimated.
//   - `low_confidence`     — delivery couldn't be measured AND the learned rate
//                            was still genuinely cold-start (few accepted
//                            samples), so the verdict rested on an unproven
//                            estimate. Gated on sample count, NOT the confidence
//                            band: the band-aware confidence "sits at low
//                            effectively forever" on thermal devices, so gating
//                            on it would make every thermal miss read "still
//                            learning" and mask the real cause.
//   - `unknown`            — not enough recorded data to attribute honestly.
//
// The delivery split (`no_delivery` / `capacity_shortfall` /
// `energy_underestimate`) is checked ahead of `low_confidence` so a clear
// delivery story always wins; `low_confidence` is the honest fallback only when
// delivery wasn't measurable.
export type DeferredPlanHistoryMissCause =
  | 'budget_limited'
  | 'no_delivery'
  | 'low_confidence'
  | 'energy_underestimate'
  | 'capacity_shortfall'
  | 'unknown';

// Fraction of the planned floor energy the executor must have delivered for a
// miss to read as an energy-needed underestimate rather than a capacity
// shortfall. 0.95 tolerates rounding and the last partial hour without letting
// a clear under-delivery masquerade as "power was available".
const DELIVERED_PLAN_FRACTION = 0.95;

// Below this delivered energy a run counts as having delivered essentially
// nothing (paired with a flat progress check below). Small absolute floor: even
// the smallest real heating/charging run clears it, so it only fires when the
// device genuinely did almost no work. Tunable.
const NO_DELIVERY_KWH_FLOOR = 0.1;

// Idle deadbands for the directional "progress toward target" check. Deadlines
// are heat-up / charge-up, so progress toward target is `final − start`; a run
// that stayed flat (or, for a mis-configured start-above-target task, cooled)
// produces a delta below the deadband and reads as no delivery. Tunable.
const NO_DELIVERY_PROGRESS_DEADBAND_C = 0.5;
const NO_DELIVERY_PROGRESS_DEADBAND_PERCENT = 1;

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

// Entry fields the attribution reads. The progress fields + `objectiveKind`
// back the directional `no_delivery` check; the rest back the delivery split and
// snapshot lookup. All present on the resolved consumer view of an entry.
type AttributionEntry = Pick<
  ResolvedDeferredObjectivePlanHistoryEntry,
  'outcome' | 'deliveredKWh' | 'finalPlan' | 'originalPlan'
  | 'objectiveKind' | 'startProgressValue' | 'finalProgressValue'
>;

const pickSnapshot = (
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'finalPlan' | 'originalPlan'>,
): AttributionSnapshot | null => entry.finalPlan ?? entry.originalPlan ?? null;

// Signed progress toward target (`final − start`) plus the per-kind deadband, or
// null when the relevant progress samples weren't recorded. Deadlines are
// heat-up / charge-up, so a delta at/above the deadband means the device made
// real progress; below it (flat, or a cooling start-above-target task) means it
// effectively didn't move.
const resolveProgressTowardTarget = (
  entry: Pick<
    AttributionEntry,
    'objectiveKind' | 'startProgressValue' | 'finalProgressValue'
  >,
): { delta: number; deadband: number } | null => {
  // Value selection is unit-agnostic; only the deadband stays kind-specific.
  const start = entry.startProgressValue;
  const final = entry.finalProgressValue;
  if (start === null || final === null || !Number.isFinite(start) || !Number.isFinite(final)) return null;
  const deadband = entry.objectiveKind === 'temperature'
    ? NO_DELIVERY_PROGRESS_DEADBAND_C
    : NO_DELIVERY_PROGRESS_DEADBAND_PERCENT;
  return { delta: final - start, deadband };
};

// True when the device delivered essentially nothing. Primary signal is the flat
// directional progress; delivered energy (when recorded) must also sit below the
// floor. When delivery wasn't recorded (legacy entries / unwired feed) the flat
// progress carries it alone. Requires progress to be known — without it we can't
// honestly claim "no delivery".
const resolveNoDelivery = (
  entry: Pick<
    AttributionEntry,
    'objectiveKind' | 'startProgressValue' | 'finalProgressValue'
  >,
  deliveredKWh: number | null,
): boolean => {
  const progress = resolveProgressTowardTarget(entry);
  if (progress === null) return false;
  if (progress.delta >= progress.deadband) return false;
  if (deliveredKWh === null) return true;
  return deliveredKWh < NO_DELIVERY_KWH_FLOOR;
};

const resolveCause = (params: {
  outcome: ResolvedDeferredObjectivePlanHistoryEntry['outcome'];
  snapshot: AttributionSnapshot | null;
  deliveredAtOrAbovePlan: boolean | null;
  noDelivery: boolean;
}): DeferredPlanHistoryMissCause | null => {
  const { outcome, snapshot, deliveredAtOrAbovePlan, noDelivery } = params;
  if (outcome !== 'missed') return null;
  // Budget exhaustion is a deliberate hold-back, so it outranks everything —
  // including a `no_delivery` that the hold-back itself produced.
  if (snapshot !== null && (snapshot.dailyBudgetExhaustedBucketCount ?? 0) > 0) {
    return 'budget_limited';
  }
  // The delivery story (entry-level, works even without a snapshot) wins over the
  // shaky-estimate fallback below: a clear "did almost nothing" / "did some but
  // short" / "delivered the plan yet short" is more honest than "still learning".
  if (noDelivery) return 'no_delivery';
  if (snapshot === null) return 'unknown';
  if (deliveredAtOrAbovePlan === false) return 'capacity_shortfall';
  if (deliveredAtOrAbovePlan === true) return 'energy_underestimate';
  // Delivery wasn't measurable. Only then fall back to "still learning", and
  // only on a genuine cold start (few accepted samples) — NOT the confidence
  // band, which sits at low effectively forever on thermal devices.
  // `typeof === 'number'` (not `!== undefined`): a persisted/legacy entry can
  // carry `acceptedSamples: null`, and `null < 4` coerces to true — which would
  // misclassify as `low_confidence` instead of the honest `unknown` fallback.
  if (
    typeof snapshot.acceptedSamples === 'number'
    && snapshot.acceptedSamples < MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP
  ) {
    return 'low_confidence';
  }
  return 'unknown';
};

const resolveDeliveredKWh = (
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'deliveredKWh'>,
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
  entry: AttributionEntry,
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
    cause: resolveCause({
      outcome: entry.outcome,
      snapshot,
      deliveredAtOrAbovePlan,
      noDelivery: resolveNoDelivery(entry, deliveredKWh),
    }),
    plannedKWh,
    deliveredKWh,
    planningSpeedKw: snapshot?.planningSpeedKw ?? null,
    rateConfidence: snapshot?.rateConfidence ?? null,
    acceptedSamples: snapshot?.acceptedSamples ?? null,
    dailyBudgetExhaustedBucketCount: snapshot?.dailyBudgetExhaustedBucketCount ?? 0,
    deliveredAtOrAbovePlan,
  };
};

// "Still learning" copy. No reading count: `low_confidence` now fires only on a
// genuine cold start (gated on `acceptedSamples < MIN_LEARNED_SAMPLES_*`), but
// the count is decoupled from the confidence band, so showing it (e.g. "(1090
// readings)") reads as broken trust. Dropping it guarantees no count can ever
// contradict the "still learning" framing. Kept tight (no "PELS was…") so it
// fits the one-line list-card reason slot at 320px; the consumer prefixes "Why:".
const STILL_LEARNING_CAUSE = "Still learning this device's energy use.";

/**
 * Composes the "Why" sentence for the miss causes that only the plan-time
 * provenance + recorded delivery (Session A) can distinguish: a device that
 * delivered almost nothing, a run that delivered the planned power yet still
 * came up short, and a genuine cold-start estimate. Returns `null` for every
 * other cause (`budget_limited`, `capacity_shortfall`, `unknown`) and for
 * non-missed outcomes.
 *
 * Deliberately narrow: the shipped budget-exhaustion and `cannot_meet` "Why"
 * copy stays owned by `formatPlanHistoryMissedReason`'s `planStatus` branches
 * so this change doesn't reword strings the UI already ships. The caller
 * inserts this refinement ahead of those branches. Tone matches the surrounding
 * blameless receipt copy.
 */
export const formatRefinedMissCause = (entry: AttributionEntry): string | null => {
  const attribution = resolveDeferredPlanHistoryMissAttribution(entry);
  switch (attribution.cause) {
    case 'no_delivery':
      return entry.objectiveKind === 'temperature'
        ? 'Delivered almost no heat before the deadline.'
        : 'Delivered almost no charge before the deadline.';
    case 'energy_underestimate':
      return 'Target needed more energy than estimated.';
    case 'low_confidence':
      return STILL_LEARNING_CAUSE;
    case 'budget_limited':
    case 'capacity_shortfall':
    case 'unknown':
    case null:
      return null;
    default: {
      // Exhaustiveness guard: a new DeferredPlanHistoryMissCause member must
      // make an explicit "Why" decision above (refined sentence or null)
      // rather than silently falling through to null.
      const exhaustive: never = attribution.cause;
      void exhaustive;
      return null;
    }
  }
};
