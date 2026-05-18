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
  DeferredObjectivePlanHistoryHourlyContribution,
  DeferredObjectivePlanHistoryProgressSample,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

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

export const captureRevisionSnapshot = (
  revision: DeferredObjectiveActivePlanRevisionV1,
  plan: DeferredObjectiveActivePlanV1 | undefined,
): DeferredObjectivePlanHistoryRevisionSnapshot => {
  const kwhPerUnitMean = pickKwhPerUnitMean(plan);
  const dailyBudgetExhaustedBucketCount = pickDailyBudgetExhaustedBucketCount(revision);
  return {
    hours: revision.hours.map((hour) => ({ ...hour })),
    energyNeededKWh: revision.energyNeededKWh,
    planStatus: revision.planStatus,
    revisedAtMs: revision.revisedAtMs,
    ...(kwhPerUnitMean !== undefined ? { kwhPerUnitMean } : {}),
    ...(dailyBudgetExhaustedBucketCount !== undefined
      ? { dailyBudgetExhaustedBucketCount }
      : {}),
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
