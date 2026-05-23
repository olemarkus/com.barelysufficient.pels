// v4 helpers for `DeferredObjectivePlanHistoryRecorder`: revision-snapshot
// capture (with `kwhPerUnitMean` from the active plan's provenance),
// progress-sample build/drain, and the symmetric-difference hour diff used
// by the per-revision log. Lives next to the recorder so the recorder can
// stay close to the 500-LOC ESLint cap.
import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryHourlyContribution,
  DeferredObjectivePlanHistoryHourlyTone,
  DeferredObjectivePlanHistoryProgressSample,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import {
  resolveDeferredPlanHistoryMissAttribution,
} from '../../../packages/shared-domain/src/deferredPlanHistoryAttribution';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

// Resolver supplied by the runtime wiring. Returns the spot price and
// resolved tone for the hour that starts at `hourStartMs`. Returning `null`
// (no price data yet, hour outside the published horizon) causes the
// rollover detector to skip the contribution — the postmortem strip is
// best-effort, not a hard requirement for finalization. See
// `lib/app/appInit.ts` for the production wiring against
// `combined_prices`.
export type HourPriceResolver = (
  hourStartMs: number,
) => { priceValue: number; tone: DeferredObjectivePlanHistoryHourlyTone } | null;

// Runtime cap on persisted progress samples per entry. The contract module
// documents a matching constant (intentionally not exported there — runtime
// must not value-import contract source files; see
// `test/runtimePackaging.test.ts`). Keep both copies in sync.
export const PROGRESS_SAMPLES_PER_ENTRY_CAP = 48;

const ONE_HOUR_MS = 60 * 60 * 1000;

// Floor a timestamp to its containing hour. Used to bucket progress samples
// so the in-memory ring keeps at most one entry per hour-of-the-run.
export const hourBucketMs = (atMs: number): number => Math.floor(atMs / ONE_HOUR_MS) * ONE_HOUR_MS;

// Effective kWh-per-unit the planner used for this revision, pulled from the
// active plan's provenance snapshot. The bands work
// (`notes/objective-profile-bands.md`) shipped `kwhPerUnitProvenance.kWhPerUnit`
// as the *integrated effective* value, so persisting it on the history
// snapshot is enough for the detail page to render a planned staircase
// trajectory without re-running the band integrator. Returns `undefined`
// when the live profile resolver short-circuited (e.g. target already met)
// or when the plan was written before provenance shipped — the UI falls back
// to a straight-line interpolation in those cases.
const pickKwhPerUnitMean = (
  plan: DeferredObjectiveActivePlanV1 | undefined,
): number | undefined => {
  const value = plan?.kwhPerUnitProvenance?.kWhPerUnit;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
};

// Pull the daily-budget-exhausted bucket count off the revision so the
// history postmortem can distinguish "missed because the daily budget cap
// was already used up" from a plain device-side shortfall. The runtime
// field is optional (legacy revisions don't carry it); we only persist
// when it's a positive count — zero means the planner checked and the
// budget was fine, which is the same answer as field-absent from the
// consumer's point of view, and suppressing it keeps the persisted entry
// byte-stable.
const pickDailyBudgetExhaustedBucketCount = (
  revision: DeferredObjectiveActivePlanRevisionV1,
): number | undefined => {
  const value = revision.dailyBudgetExhaustedBucketCount;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
};

// Plan-time confidence band of the learned rate, pulled from the active
// plan's provenance. Mirrors the band the live smart-task chip would have
// shown when this run was planned (`displayConfidence` when present, else the
// raw per-sample `confidence`). Returns `undefined` for bootstrap plans (no
// learned profile) and when no provenance was recorded — the attribution then
// suppresses its confidence half rather than asserting a band it never saw.
const pickRateConfidence = (
  plan: DeferredObjectiveActivePlanV1 | undefined,
): 'low' | 'medium' | 'high' | undefined => {
  const provenance = plan?.kwhPerUnitProvenance;
  if (!provenance) return undefined;
  const band = provenance.displayConfidence ?? provenance.confidence;
  return band ?? undefined;
};

// Accepted-sample count behind the learned rate at plan time. Zero (bootstrap)
// is suppressed the same way absence is — the attribution treats both as "no
// learned support yet", and suppressing keeps the persisted entry byte-stable.
const pickAcceptedSamples = (
  plan: DeferredObjectiveActivePlanV1 | undefined,
): number | undefined => {
  const value = plan?.kwhPerUnitProvenance?.acceptedSamples;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
};

// The committed full-hour floor power (kW) the planner sized the run against,
// frozen on the active plan at first revision. Suppressed when absent or
// non-positive so the attribution's floor-vs-delivered comparison opts out
// rather than dividing against a zero floor.
const pickPlanningSpeedKw = (
  plan: DeferredObjectiveActivePlanV1 | undefined,
): number | undefined => {
  const value = plan?.initialPlanningSpeedKw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
};

// Build the `deferred_objective_history_finalized` structured-debug payload for
// a finalized entry. Carries the resolved miss attribution (cause + the raw
// plan-time confidence / committed-floor / delivery inputs it rested on) so the
// telemetry can count genuine capacity misses versus shaky-estimate /
// conservative-planning false alarms. Lives here (not on the recorder) so the
// recorder file stays under the 500-LOC cap and the shared-domain attribution
// import sits beside the other history-shaping helpers.
export const buildFinalizedAttributionEvent = (
  entry: DeferredObjectivePlanHistoryEntry,
): Record<string, unknown> => {
  const attribution = resolveDeferredPlanHistoryMissAttribution(entry);
  return {
    event: 'deferred_objective_history_finalized',
    deviceId: entry.deviceId,
    objectiveKind: entry.objectiveKind,
    outcome: entry.outcome,
    missCause: attribution.cause,
    plannedKWh: attribution.plannedKWh,
    deliveredKWh: attribution.deliveredKWh,
    planningSpeedKw: attribution.planningSpeedKw,
    rateConfidence: attribution.rateConfidence,
    acceptedSamples: attribution.acceptedSamples,
    dailyBudgetExhaustedBucketCount: attribution.dailyBudgetExhaustedBucketCount,
    deliveredAtOrAbovePlan: attribution.deliveredAtOrAbovePlan,
  };
};

export const captureRevisionSnapshot = (
  revision: DeferredObjectiveActivePlanRevisionV1,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): DeferredObjectivePlanHistoryRevisionSnapshot => {
  const kwhPerUnitMean = pickKwhPerUnitMean(plan);
  const dailyBudgetExhaustedBucketCount = pickDailyBudgetExhaustedBucketCount(revision);
  const rateConfidence = pickRateConfidence(plan);
  const acceptedSamples = pickAcceptedSamples(plan);
  const planningSpeedKw = pickPlanningSpeedKw(plan);
  return {
    hours: revision.hours.map((hour) => ({ ...hour })),
    energyNeededKWh: revision.energyNeededKWh,
    planStatus: revision.planStatus,
    revisedAtMs: revision.revisedAtMs,
    ...(kwhPerUnitMean !== undefined ? { kwhPerUnitMean } : {}),
    ...(dailyBudgetExhaustedBucketCount !== undefined
      ? { dailyBudgetExhaustedBucketCount }
      : {}),
    ...(rateConfidence !== undefined ? { rateConfidence } : {}),
    ...(acceptedSamples !== undefined ? { acceptedSamples } : {}),
    ...(planningSpeedKw !== undefined ? { planningSpeedKw } : {}),
  };
};

// Diagnostic reason codes that mean the `currentTemperatureC` /
// `currentPercent` values are present but **not trustworthy** — sensor stale,
// session invalid, missing device, missing temperature, or invalid deadline.
// Writing these into `progressSamples` would pollute the history chart with
// untrusted telemetry, so the recorder gates writes on this set the same way
// `finalProgress*` does.
export const PROGRESS_UNTRUSTWORTHY_REASON_CODES: ReadonlySet<DeferredObjectiveDiagnostic['reasonCode']> = new Set([
  'objective_invalid_deadline',
  'objective_invalid_session',
  'objective_missing_device',
  'objective_missing_temperature',
  'objective_progress_stale',
]);

// True iff the diagnostic carries fresh, trustworthy progress for its kind.
// Mirrors the gating `planHistory.ts` already applies before writing
// `finalProgressC` / `finalProgressPercent`, so progress samples never
// disagree with the headline value the UI shows.
export const hasTrustworthyProgress = (diag: DeferredObjectiveDiagnostic): boolean => {
  if (PROGRESS_UNTRUSTWORTHY_REASON_CODES.has(diag.reasonCode)) return false;
  if (diag.objectiveKind === 'temperature') {
    return diag.currentTemperatureC !== null;
  }
  return diag.currentPercent !== null && diag.targetPercent !== null;
};

// Build a progress sample from the diagnostic. Returns null when the
// diagnostic carries no trustworthy progress (stale sensor, invalid session,
// missing device/temperature, invalid deadline) so the ring never accumulates
// untrusted telemetry. Also returns null when neither kind-specific value is
// present, as a defense-in-depth — `hasTrustworthyProgress` should already
// rule this out.
const buildProgressSample = (
  diag: DeferredObjectiveDiagnostic,
  atMs: number,
): DeferredObjectivePlanHistoryProgressSample | null => {
  if (!hasTrustworthyProgress(diag)) return null;
  const valueC = diag.objectiveKind === 'temperature' ? diag.currentTemperatureC : null;
  const valuePercent = diag.objectiveKind === 'ev_soc' ? diag.currentPercent : null;
  if (valueC === null && valuePercent === null) return null;
  return { atMs, valueC, valuePercent };
};

// Seed the in-memory progress ring with the first observation so a run that
// finalizes on the same cycle it started (immediate satisfied diagnostic)
// still drains at least one sample. Returns an empty map when the
// diagnostic carries no trustworthy progress.
export const seedProgressSamples = (
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
): Map<number, DeferredObjectivePlanHistoryProgressSample> => {
  const map = new Map<number, DeferredObjectivePlanHistoryProgressSample>();
  const sample = buildProgressSample(diag, nowMs);
  if (sample !== null) map.set(hourBucketMs(nowMs), sample);
  return map;
};

// Upsert the diagnostic's current progress into the hourly ring. One entry
// per hour-of-the-run; later cycles within the same hour overwrite (latest
// reading wins). Drops diagnostics that carry no fresh progress so the ring
// never accumulates all-null rows.
export const recordProgressSample = (
  current: Map<number, DeferredObjectivePlanHistoryProgressSample>,
  diag: DeferredObjectiveDiagnostic,
  nowMs: number,
): Map<number, DeferredObjectivePlanHistoryProgressSample> => {
  const sample = buildProgressSample(diag, nowMs);
  if (sample === null) return current;
  const next = new Map(current);
  next.set(hourBucketMs(nowMs), sample);
  return next;
};

// Drain the in-memory hourly progress ring into a sorted, capped array. The
// cap (`PROGRESS_SAMPLES_PER_ENTRY_CAP`) keeps the persisted entry bounded
// even if the recorder somehow accumulates more samples than expected;
// dropping the *oldest* preserves the most recent (and most diagnostically
// useful) readings while ensuring the final `finalProgressC` headline value
// still appears in the chart.
export const drainProgressSamples = (
  samples: Map<number, DeferredObjectivePlanHistoryProgressSample>,
): DeferredObjectivePlanHistoryProgressSample[] => {
  if (samples.size === 0) return [];
  const sorted = [...samples.values()].sort((a, b) => a.atMs - b.atMs);
  if (sorted.length <= PROGRESS_SAMPLES_PER_ENTRY_CAP) return sorted;
  return sorted.slice(sorted.length - PROGRESS_SAMPLES_PER_ENTRY_CAP);
};

// Append a revision-log entry the first time we observe a higher
// `latest.revision` than what we already logged. Skip the seed revision
// (`revision === 1`) — its metadata is on `originalPlan`. Idempotent so a
// cycle that observes the same plan twice doesn't double-log. Comparing by
// timestamp (rather than revision index) keeps the log stable across an
// `objective_changed` reset, where the planner restarts the index from 1.
//
// Mid-run pickup guard: when `startRecord` seeds `finalPlan` with the
// observed revision and the next cycle calls this helper with that same
// snapshot as `previousFinalPlan`, we'd otherwise log a phantom +0/-0
// entry. The recorder can't honestly count replans it didn't witness, so
// when the snapshot already represents this revision, skip the log.
export const appendRevisionLogIfNew = (
  existing: readonly DeferredObjectivePlanHistoryRevisionLogEntry[],
  previousFinalPlan: DeferredObjectivePlanHistoryRevisionSnapshot | null,
  nextRevision: DeferredObjectiveActivePlanRevisionV1,
): DeferredObjectivePlanHistoryRevisionLogEntry[] => {
  if (nextRevision.revision <= 1) return existing.slice();
  if (previousFinalPlan?.revisedAtMs === nextRevision.revisedAtMs) return existing.slice();
  if (existing.some((entry) => entry.atMs === nextRevision.revisedAtMs)) return existing.slice();
  const previousHours = previousFinalPlan?.hours ?? [];
  const { hoursAdded, hoursRemoved } = diffHourSchedules(previousHours, nextRevision.hours);
  return [...existing, {
    atMs: nextRevision.revisedAtMs,
    reasonId: nextRevision.reason,
    hoursAdded,
    hoursRemoved,
  }];
};

// Symmetric-difference counts of `startsAtMs` between two hour schedules.
// O(n + m) via a Set; ordering is irrelevant — the recorder logs the count
// so the UI can render "+2 / −1" without needing the specific timestamps.
const diffHourSchedules = (
  previous: readonly { startsAtMs: number }[],
  next: readonly { startsAtMs: number }[],
): { hoursAdded: number; hoursRemoved: number } => {
  const previousStarts = new Set(previous.map((hour) => hour.startsAtMs));
  const nextStarts = new Set(next.map((hour) => hour.startsAtMs));
  let hoursAdded = 0;
  for (const startsAtMs of nextStarts) if (!previousStarts.has(startsAtMs)) hoursAdded += 1;
  let hoursRemoved = 0;
  for (const startsAtMs of previousStarts) if (!nextStarts.has(startsAtMs)) hoursRemoved += 1;
  return { hoursAdded, hoursRemoved };
};

// Hour-aligned snapshot of a trustworthy progress reading. The hour-rollover
// detector keeps one of these for the "current hour's opening" (the first
// trustworthy reading observed in the hour) so it can compute delivered kWh
// for the hour by subtracting the opening value from the latest reading when
// the hour closes. `value` is in the objective's native unit (°C or %); the
// caller multiplies by kWh-per-unit to convert.
export type HourProgressSnapshot = {
  hourMs: number;
  value: number;
};

// Pick the effective kWh-per-unit factor for the diagnostic's kind. Returns
// null when no profile (learned or bootstrap) has resolved yet — without
// kWh/unit we can't translate progress delta into delivered kWh, so the
// rollover skips emission for that cycle and the contribution lands as
// "not measured" in the postmortem rather than as a fabricated zero.
export const pickKwhPerUnit = (diag: DeferredObjectiveDiagnostic): number | null => {
  const value = diag.objectiveKind === 'temperature' ? diag.kWhPerDegreeC : diag.kWhPerPercent;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
};

// Result of one rollover step: zero or more closed-hour contributions plus
// the updated opening snapshot. The caller (the recorder) folds the
// contributions into the in-progress record and stores the new opening.
export type HourRolloverResult = {
  contributions: DeferredObjectivePlanHistoryHourlyContribution[];
  nextOpening: HourProgressSnapshot;
};

// Detect an hour-bucket transition for an in-progress run with trustworthy
// progress. Inputs:
//   - `opening` — first trustworthy reading observed in the current open
//     hour. `null` when the recorder has not yet anchored an opening
//     snapshot (start of run, or after a stretch of untrustworthy readings).
//   - `nowProgress` — current cycle's trustworthy reading.
//   - `nowMs` — current cycle timestamp.
//   - `kWhPerUnit` — multiplier resolving progress delta to delivered kWh.
//   - `resolvePrice` — optional resolver that supplies hourly price+tone.
//     `undefined` resolver or `null` lookup skips emission (no price → no
//     contribution; the strip suppresses these hours instead of guessing).
// Returns the contribution(s) to append (currently zero or one) and the new
// opening snapshot to store. Returns `null` when no transition occurred and
// no contribution should fire.
//
// Contract: the postmortem strip is observation-bucketed, not prorated.
// Under `power_source = homey_energy` the recorder runs from the ~10 s
// energy poll so multi-hour gaps are rare. Under `power_source = flow`
// samples are event-driven and may arrive at arbitrary intervals — a
// stretch with no observations followed by a single reading N hours later
// attributes the full delta to `opening.hourMs` (the hour we last
// observed), leaving intermediate hours blank rather than fabricating
// intermediate bars. Proration across an unobserved window would require
// independent power telemetry per hour and is deliberately out of scope
// here. See `TODO.md` for the follow-up.
export const detectHourRollover = (params: {
  opening: HourProgressSnapshot | null;
  nowProgress: number;
  nowMs: number;
  kWhPerUnit: number;
  resolvePrice?: HourPriceResolver;
}): HourRolloverResult | null => {
  const { opening, nowProgress, nowMs, kWhPerUnit, resolvePrice } = params;
  const currentHourMs = hourBucketMs(nowMs);
  if (opening === null) {
    return { contributions: [], nextOpening: { hourMs: currentHourMs, value: nowProgress } };
  }
  if (currentHourMs <= opening.hourMs) {
    // Same hour (or — defensively — a clock jump backwards): keep the
    // original opening so a backwards-skewed reading doesn't reset our
    // anchor. The latest reading is captured by the caller via the
    // progress-sample ring.
    return null;
  }
  // Hour boundary crossed. The `opening` snapshot is the first trustworthy
  // reading we anchored in its hour; the `nowProgress` reading is the first
  // trustworthy reading we've seen in the just-entered hour. We attribute the
  // full opening→now delta to `opening.hourMs` and re-anchor the opening at
  // `nowProgress` for the new hour. This is conservative on both sides: any
  // progress accumulated between `opening.value` and the true end-of-hour
  // lands on `opening.hourMs` (where it largely belongs), and any progress
  // between the start of the new hour and `nowProgress` is also folded into
  // `opening.hourMs` rather than back-dated to the new hour. When observations
  // skip intervening hours entirely, those hours stay blank rather than
  // receiving a fabricated split — proration would require independent
  // per-hour power telemetry (see the contract note above and `TODO.md`).
  const deliveredUnits = nowProgress - opening.value;
  const nextOpening: HourProgressSnapshot = { hourMs: currentHourMs, value: nowProgress };
  if (deliveredUnits <= 0) {
    // Progress didn't advance (or regressed — sensor drift, EV unplugged
    // mid-hour). No contribution; advance the opening so subsequent hours
    // don't double-count against the old anchor.
    return { contributions: [], nextOpening };
  }
  if (!resolvePrice) return { contributions: [], nextOpening };
  const pricing = resolvePrice(opening.hourMs);
  if (pricing === null) return { contributions: [], nextOpening };
  const deliveredKWh = deliveredUnits * kWhPerUnit;
  return {
    contributions: [{
      atMs: opening.hourMs,
      deliveredKWh,
      priceValue: pricing.priceValue,
      tone: pricing.tone,
    }],
    nextOpening,
  };
};

// Emit a final contribution for the still-open hour at run finalization.
// Mirrors `detectHourRollover` but is called once at finalize-time so a
// run that completed inside a single hour (short EV top-up, sub-hour
// thermal nudge) still produces at least one bar on the postmortem strip
// instead of dropping its delivery entirely. Returns null when there is
// no opening anchor or no measurable progress delta to flush.
export const buildFinalHourContribution = (params: {
  opening: HourProgressSnapshot | null;
  finalProgress: number | null;
  kWhPerUnit: number | null;
  resolvePrice?: HourPriceResolver;
}): DeferredObjectivePlanHistoryHourlyContribution | null => {
  const { opening, finalProgress, kWhPerUnit, resolvePrice } = params;
  if (opening === null || finalProgress === null || kWhPerUnit === null) return null;
  const deliveredUnits = finalProgress - opening.value;
  if (deliveredUnits <= 0) return null;
  if (!resolvePrice) return null;
  const pricing = resolvePrice(opening.hourMs);
  if (pricing === null) return null;
  return {
    atMs: opening.hourMs,
    deliveredKWh: deliveredUnits * kWhPerUnit,
    priceValue: pricing.priceValue,
    tone: pricing.tone,
  };
};

// Append (or merge) a per-hour delivery contribution onto the running list
// the recorder keeps on an in-progress run. If an entry already exists for
// `next.atMs`, the kWh is summed and the latest price/tone wins — the
// recorder's wiring contract is one-shot push per hour, so duplicates only
// happen when an aggregator replays a missed slot; in that case the
// fresher price/tone is the authoritative one for the postmortem.
export const appendHourlyContribution = (
  list: readonly DeferredObjectivePlanHistoryHourlyContribution[],
  next: DeferredObjectivePlanHistoryHourlyContribution,
): DeferredObjectivePlanHistoryHourlyContribution[] => {
  const existingIndex = list.findIndex((entry) => entry.atMs === next.atMs);
  if (existingIndex === -1) {
    return [...list, next];
  }
  const merged: DeferredObjectivePlanHistoryHourlyContribution = {
    atMs: next.atMs,
    deliveredKWh: list[existingIndex]!.deliveredKWh + next.deliveredKWh,
    priceValue: next.priceValue,
    tone: next.tone,
  };
  return list.map((entry, index) => (index === existingIndex ? merged : entry));
};
