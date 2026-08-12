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

import type { DeferredObjectiveActivePlanFloorShortfallCause } from '../../contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryRevisionSnapshot,
  ResolvedDeferredObjectivePlanHistoryEntry,
} from '../../contracts/src/deferredObjectivePlanHistory';
import { MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP } from './deadlineLabels';
import { snapshotShowsBudgetExhausted } from './deferredPlanHistoryShared';
import {
  asDeliveredEnergyKWh,
  asPlannedFloorEnergyKWh,
  asRemainingEnergyKWh,
  type DeliveredEnergyKWh,
  type PlannedFloorEnergyKWh,
  type RemainingEnergyKWh,
} from './energyQuantities';

// Why a `missed` run missed, in the order we check (most concrete cause wins):
//   - `budget_limited`     — the soft daily budget bound the planner's floor;
//                            the device was held back on purpose.
//   - `no_delivery`        — the device delivered essentially no useful energy
//                            and made no progress toward target; the most
//                            concrete, device-actionable miss.
//   - `capacity_shortfall` — there was not enough deliverable power or time,
//                            either because the producer said so at plan time
//                            (`floorShortfallCause`) or because a plan that
//                            looked feasible under-delivered against its own
//                            committed requirement.
//   - `energy_underestimate` — the plan looked feasible AND the executor
//                            delivered what the run set out to need, yet the
//                            target still wasn't reached: the kWh-per-unit rate
//                            was too low.
//   - `low_confidence`     — the verdict rested on an unproven estimate: either
//                            the producer attributed the floor shortfall to its
//                            own variance padding (`estimate`), or delivery
//                            couldn't be measured and the rate was still
//                            genuinely cold-start (few accepted samples). Gated
//                            on sample count, NOT the confidence band: the
//                            band-aware confidence "sits at low effectively
//                            forever" on thermal devices, so gating on it would
//                            make every thermal miss read "still learning" and
//                            mask the real cause.
//   - `unknown`            — not enough recorded data to attribute honestly.
//
// THE PRODUCER'S VERDICT WINS. `floorShortfallCause` is resolved once, at plan
// time, through a single shared table (`floorShortfallCause.ts`) and persisted
// on the revision. This module reads it rather than re-deriving a cause from
// arithmetic — per `feedback_layering_resolution_in_producer`. The
// delivered-vs-committed comparison is consulted ONLY where the producer
// recorded no shortfall (`none` / absent), because that is the one case its
// verdict doesn't cover: the plan said it would make it, and it didn't.
//
// The comparison basis is the ORIGINAL revision's mean requirement, never the
// final revision's. `energyExpectedKWh` is `mean × remainingUnits` — it shrinks
// as a run delivers, so comparing a run's cumulative delivery against a late
// revision's figure compares two different quantities. Doing exactly that is
// what made a nine-hour capacity-bound EV run report "Target needed more energy
// than estimated"; see `resolveDeliveredAtOrAboveCommitment`.
export type DeferredPlanHistoryMissCause =
  | 'budget_limited'
  | 'no_delivery'
  | 'low_confidence'
  | 'energy_underestimate'
  | 'capacity_shortfall'
  | 'unknown';

// Fraction of the run's committed energy requirement the executor must have
// delivered for a miss to read as an energy-needed underestimate rather than a
// capacity shortfall. 0.95 tolerates rounding and the last partial hour without
// letting a clear under-delivery masquerade as "power was available".
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
  | 'floorShortfallCause' | 'energyNeededKWh'
>;

/**
 * The planner's last word: `planStatus`, `floorShortfallCause` and the rate
 * provenance. Falls back to the original snapshot when the run finalized before
 * any replan — the same field read from the latest revision that exists, not a
 * different quantity.
 *
 * Note what this is NOT used for: the commitment the delivered-vs-committed
 * comparison needs. No revision snapshot can supply that. Each one's
 * `energyExpectedKWh` is a shrinking remainder, and `originalPlan` is not the
 * original revision — the recorder defines it as the richest schedule the
 * planner ever achieved and replaces it mid-run (`pickRicherSnapshot`), while a
 * restart that loses the active plan reseeds `plan.original` from the current
 * mid-run revision. The commitment is therefore anchored once by the producer,
 * on the entry itself, as `initialEnergyExpectedKWh`.
 */
const pickFinalRevision = (
  entry: Pick<ResolvedDeferredObjectivePlanHistoryEntry, 'finalPlan' | 'originalPlan'>,
): AttributionSnapshot | null => entry.finalPlan ?? entry.originalPlan ?? null;

const sumPlannedFloorKWh = (
  snapshot: AttributionSnapshot | null,
): PlannedFloorEnergyKWh | null => {
  if (snapshot === null) return null;
  let total = 0;
  for (const hour of snapshot.hours) {
    if (Number.isFinite(hour.plannedKWh) && hour.plannedKWh > 0) total += hour.plannedKWh;
  }
  return asPlannedFloorEnergyKWh(total);
};

// Resolved attribution for a finalized run. `cause` is null on outcomes other
// than `missed` — a met / abandoned / replaced run has nothing to attribute. An
// unclassifiable miss is `'unknown'`, an in-band member, never null.
//
// The remaining fields are the raw inputs the classification rested on,
// surfaced so the runtime structured log can correlate causes across runs
// without re-deriving. They stay nullable ON THE PAYLOAD because "not recorded"
// is a real thing for a persisted history entry — but nothing downstream of the
// resolution reads them nullable: the decision path works on the branded,
// non-nullable values resolved once at the top of
// `resolveDeferredPlanHistoryMissAttribution`.
export type DeferredPlanHistoryMissAttribution = {
  cause: DeferredPlanHistoryMissCause | null;
  plannedKWh: number | null;
  deliveredKWh: number | null;
  planningSpeedKw: number | null;
  rateConfidence: 'low' | 'medium' | 'high' | null;
  acceptedSamples: number | null;
  dailyBudgetExhaustedBucketCount: number;
  // True when the executor delivered at/above what the ORIGINAL revision said
  // this run needed. Null when delivery or that commitment wasn't recorded.
  // Consulted only when the producer recorded no floor shortfall — see
  // `resolveCause`. Reported unconditionally because it is useful telemetry
  // even where it did not select the cause.
  deliveredAtOrAbovePlan: boolean | null;
};

// Entry fields the attribution reads. The progress fields + `objectiveKind`
// back the directional `no_delivery` check; the rest back the delivery split and
// revision lookup. All present on the resolved consumer view of an entry.
type AttributionEntry = Pick<
  ResolvedDeferredObjectivePlanHistoryEntry,
  'outcome' | 'deliveredKWh' | 'finalPlan' | 'originalPlan'
  | 'objectiveKind' | 'startProgressValue' | 'finalProgressValue'
  | 'initialEnergyExpectedKWh'
>;

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
  deliveredKWh: DeliveredEnergyKWh | null,
): boolean => {
  const progress = resolveProgressTowardTarget(entry);
  if (progress === null) return false;
  if (progress.delta >= progress.deadband) return false;
  if (deliveredKWh === null) return true;
  return deliveredKWh < NO_DELIVERY_KWH_FLOOR;
};

// Maps the producer's plan-time verdict onto a miss cause. `budget` is handled
// ahead of this by `snapshotShowsBudgetExhausted` (which also honours the
// retired count), and `none` returns null so the caller falls through to the
// delivered-vs-committed split.
//
// `estimate` resolves to `low_confidence`, NOT `energy_underestimate`. The two
// point in opposite directions: `floorShortfallCause.ts` defines `estimate` as
// "the mean rate would fit and only the `k·SE` padding causes the gap" — the
// planner was conservative — whereas `energy_underestimate` claims the target
// needed MORE energy than estimated. Reading the former as the latter would tell
// an owner their estimate was too low when the record says it was too cautious.
// Keyed by the contract union so adding a cause fails to COMPILE here rather
// than silently falling through to the delivery split — the same guard
// `planHistorySettings.FLOOR_SHORTFALL_CAUSES` uses for the same union.
// `budget` is `null` because `snapshotShowsBudgetExhausted` claims it earlier
// (it also honours the retired count); `none` is `null` because "no shortfall"
// is not a cause.
const CAUSE_BY_FLOOR_SHORTFALL: Record<
  DeferredObjectiveActivePlanFloorShortfallCause,
  DeferredPlanHistoryMissCause | null
> = {
  budget: null,
  time_capacity: 'capacity_shortfall',
  // NOT a capacity shortfall. `step_power` is the floor-step undercount —
  // "climbing within budget fits" (`floorShortfallCause.ts`), and the module
  // AGENTS.md is blunter still: "the climbed-band probe already proved the
  // booked hours do the job once the executor climbs (the normal state of a
  // stepped thermal task)". It is a statement that the task CAN finish, so
  // reporting "Not enough power or time" from it would be backwards. With no
  // delivery evidence there is nothing to attribute, and `unknown` is honest.
  step_power: null,
  // Also claimed earlier, and for the same reason as `budget`: `estimate` has
  // to outrank the delivery split (it is the producer saying the gap was its
  // own padding), so `resolveCause` returns on it before this table is ever
  // consulted. Null here rather than a second copy of the mapping — one rule,
  // one place, and the exhaustiveness guard still fires on a sixth cause.
  estimate: null,
  none: null,
};

const causeFromFloorShortfall = (
  snapshot: AttributionSnapshot | null,
): DeferredPlanHistoryMissCause | null => {
  const cause = snapshot?.floorShortfallCause;
  return cause === undefined ? null : CAUSE_BY_FLOOR_SHORTFALL[cause] ?? null;
};

// True when the learned rate was still genuinely cold-start.
// `typeof === 'number'` (not `!== undefined`): a persisted/legacy entry can
// carry `acceptedSamples: null`, and `null < 4` coerces to true — which would
// misclassify as `low_confidence` instead of the honest `unknown` fallback.
const isColdStartEstimate = (snapshot: AttributionSnapshot | null): boolean => (
  typeof snapshot?.acceptedSamples === 'number'
  && snapshot.acceptedSamples < MIN_LEARNED_SAMPLES_FOR_CONFIDENT_CHIP
);

/**
 * Cause priority. Two different kinds of evidence decide here, and which one
 * leads depends on the question:
 *
 * The producer's `floorShortfallCause` is authoritative for the questions it
 * actually answers — `budget` (the soft daily budget bound the floor) and
 * `estimate` (the gap was the producer's own `k·SE` padding). Those are read,
 * never re-derived.
 *
 * It is NOT authoritative for power-versus-estimate, and that is the subtle
 * part. `target_cannot_be_met` maps to `time_capacity`, and a run that missed
 * because its learned rate was too LOW ends up there too: as the requirement is
 * recomputed upward mid-run, the planner eventually reports it cannot meet the
 * target. Letting `time_capacity` win outright would tell an owner "not enough
 * power" whenever the real fault was the estimate — the mirror image of the bug
 * this module was rewritten to fix, and it would make `energy_underestimate`
 * nearly unreachable.
 *
 * What does separate them is the delivery evidence: a run that delivered what
 * it set out to need and still missed had its requirement underestimated; one
 * that did not deliver it was short on power or time. So the
 * delivered-vs-committed split leads, and `floorShortfallCause` covers the case
 * where delivery could not be measured.
 */
const resolveCause = (params: {
  outcome: ResolvedDeferredObjectivePlanHistoryEntry['outcome'];
  finalRevision: AttributionSnapshot | null;
  deliveredAtOrAbovePlan: boolean | null;
  noDelivery: boolean;
}): DeferredPlanHistoryMissCause | null => {
  const { outcome, finalRevision, deliveredAtOrAbovePlan, noDelivery } = params;
  if (outcome !== 'missed') return null;
  // Budget is a deliberate hold-back, so it outranks everything — including a
  // `no_delivery` the hold-back itself produced. Routed through the shared
  // resolver, which honours BOTH the live `floorShortfallCause === 'budget'`
  // and the retired count. Hand-rolling only the retired half here is what let
  // the runtime log report a different cause than the UI line for a modern
  // budget-bound miss.
  if (snapshotShowsBudgetExhausted(finalRevision)) return 'budget_limited';
  // The delivery story is entry-level and works without any revision, so it
  // stays ahead of everything that needs one.
  if (noDelivery) return 'no_delivery';
  // The producer attributed the shortfall to its own variance padding. That is
  // a statement about the estimate's confidence, and no delivery figure
  // second-guesses it.
  if (finalRevision?.floorShortfallCause === 'estimate') return 'low_confidence';
  // The discriminator: did the run deliver what it committed to?
  if (deliveredAtOrAbovePlan === true) return 'energy_underestimate';
  if (deliveredAtOrAbovePlan === false) return 'capacity_shortfall';
  // Delivery or the commitment wasn't recorded, so fall back to the producer's
  // plan-time verdict for the runs it covers.
  if (finalRevision === null) return 'unknown';
  const plannedCause = causeFromFloorShortfall(finalRevision);
  if (plannedCause !== null) return plannedCause;
  // Nothing recorded either way. Only now fall back to "still learning", and
  // only on a genuine cold start — NOT the confidence band, which sits at low
  // effectively forever on thermal devices.
  if (isColdStartEstimate(finalRevision)) return 'low_confidence';
  return 'unknown';
};

/**
 * Did the executor deliver what this run set out to need?
 *
 * The basis is `entry.initialEnergyExpectedKWh` — the run's committed mean
 * requirement, anchored once by the producer at `startRecord` and never
 * revised. Mean-based (not the buffered `plannedKWh` sum) so a cold-start run
 * whose buffer was inflated by a wide `k·SE` band isn't called a capacity
 * shortfall when delivery actually met the underlying estimate.
 *
 * Every revision-derived alternative is a moving target: each snapshot's
 * `energyExpectedKWh` is the energy still OUTSTANDING at that revision, which
 * shrinks as the run delivers, and `originalPlan` is whichever snapshot had the
 * most hours rather than the first. Comparing cumulative delivery against
 * either is comparing two different quantities, and the error is systematic
 * rather than occasional — the harder a device fights a real capacity limit,
 * the smaller the remainder and the more likely the comparison is to report an
 * estimation error instead.
 *
 * Null when either side wasn't recorded, and the caller then declines the
 * comparison rather than substituting another quantity.
 */
const resolveDeliveredAtOrAboveCommitment = (
  deliveredKWh: DeliveredEnergyKWh | null,
  committedKWh: RemainingEnergyKWh | null,
): boolean | null => {
  if (deliveredKWh === null || committedKWh === null) return null;
  return deliveredKWh >= committedKWh * DELIVERED_PLAN_FRACTION;
};

/**
 * Resolves the miss attribution for a finalized history entry. Pure and
 * browser-safe: reads only the persisted entry, so the runtime structured log
 * and the UI render path resolve the same `missCause` by construction rather
 * than by both being handed the same value.
 *
 * There is deliberately no live-value parameter. The recorder used to thread
 * one from the in-flight revision at finalize time, while the same finalize
 * pass wrote that identical number onto the snapshot — so the two could never
 * disagree, and the argument was a sequencing artifact from when the log was
 * emitted before persistence.
 *
 * Returns a fully-populated structure on every call (payload fields null when
 * their input wasn't recorded) so the structured log can forward it verbatim.
 */
export const resolveDeferredPlanHistoryMissAttribution = (
  entry: AttributionEntry,
): DeferredPlanHistoryMissAttribution => {
  const finalRevision = pickFinalRevision(entry);
  // Reported telemetry, not a decision input: the buffered hours sum as the
  // planner last had it.
  const plannedFloorKWh = sumPlannedFloorKWh(finalRevision);
  const deliveredKWh = asDeliveredEnergyKWh(entry.deliveredKWh);
  const deliveredAtOrAbovePlan = resolveDeliveredAtOrAboveCommitment(
    deliveredKWh,
    asRemainingEnergyKWh(entry.initialEnergyExpectedKWh),
  );
  return {
    cause: resolveCause({
      outcome: entry.outcome,
      finalRevision,
      deliveredAtOrAbovePlan,
      noDelivery: resolveNoDelivery(entry, deliveredKWh),
    }),
    plannedKWh: plannedFloorKWh,
    deliveredKWh,
    planningSpeedKw: finalRevision?.planningSpeedKw ?? null,
    rateConfidence: finalRevision?.rateConfidence ?? null,
    acceptedSamples: finalRevision?.acceptedSamples ?? null,
    dailyBudgetExhaustedBucketCount: finalRevision?.dailyBudgetExhaustedBucketCount ?? 0,
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
 * Composes the "Why" sentence for the miss causes the plan-time provenance +
 * recorded delivery can distinguish: a device that delivered almost nothing, a
 * run that delivered what it committed to yet still came up short, a genuine
 * cold-start estimate, and a run there simply wasn't enough power or time for.
 * Returns `null` for `budget_limited` (whose copy the caller owns and checks
 * first), for `unknown`, and for non-missed outcomes.
 *
 * `capacity_shortfall` gained a sentence here because without one it fell
 * through to the caller's `planStatus` branches — most visibly the `cannot_meet`
 * line, "Couldn't reserve enough cheap hours in time.", which blames the price
 * curve for a run that was capacity- or budget-paced and reads as nonsense on a
 * flat-price night.
 *
 * It names power AND time deliberately. `floorShortfallCause` collapses two
 * reason codes into `time_capacity` (`target_cannot_be_met`,
 * `limited_by_higher_priority_task`), and that cause is defined as
 * "physical/time even uncapped" — so a deadline that was simply too soon for the
 * device's rate lands here alongside a genuinely power-starved run. The
 * persisted data cannot tell those apart, so a power-only sentence would send an
 * owner hunting for power they never needed. Per `feedback_hard_cap_is_physical`
 * it states what happened and suggests no remedy; the recourse button owns that.
 *
 * Tone matches the surrounding blameless receipt copy; kept tight so it fits the
 * one-line list-card reason slot at 320px (the consumer prefixes "Why:").
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
    case 'capacity_shortfall':
      return 'Not enough power or time before the deadline.';
    case 'low_confidence':
      return STILL_LEARNING_CAUSE;
    case 'budget_limited':
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
