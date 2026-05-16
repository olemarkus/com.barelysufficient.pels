import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanOutcome,
} from '../../contracts/src/deferredObjectivePlanHistory.js';
import { formatTimeInTimeZone } from './utils/dateUtils.js';

export type DeferredPlanHistoryChipTone = 'ok' | 'warn' | 'muted';

// Canonical Smart-task list date+time format, e.g. `Sat 16 May 06:50`.
//
// Both the active Smart-tasks list (`DeadlinesList.tsx`) and the past-tasks
// list (`DeadlinesHistoryList.tsx` via `DeadlinePlanHistory.tsx`) route their
// timestamps through this helper so the two columns can't drift apart again.
// Pinned to `en-GB` so the day-of-month-then-month ordering ("16 May") is
// stable across CI (en-US default) and developer machines (en-GB/en-DK).
// `formatDateInTimeZone` would otherwise inherit the runtime's default locale
// and render `Sat, May 16` on en-US, breaking regression tests.
const SMART_TASK_DATE_LOCALE = 'en-GB';

export const formatSmartTaskListDateTime = (
  ms: number,
  timeZone = 'UTC',
): string => {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const dateLabel = new Intl.DateTimeFormat(SMART_TASK_DATE_LOCALE, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
  const timeLabel = formatTimeInTimeZone(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }, timeZone);
  return `${dateLabel} ${timeLabel}`;
};

export const formatPlanHistoryDeadlineLine = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'deadlineAtMs'>,
  timeZone = 'UTC',
): string => formatSmartTaskListDateTime(entry.deadlineAtMs, timeZone);

const formatTemperature = (value: number | null): string | null => (
  value === null ? null : `${value.toFixed(1)} °C`
);

const formatPercent = (value: number | null): string | null => (
  value === null ? null : `${value.toFixed(0)} %`
);

export const formatPlanHistoryProgressLine = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'objectiveKind'
    | 'targetTemperatureC'
    | 'targetPercent'
    | 'startProgressC'
    | 'startProgressPercent'
    | 'finalProgressC'
    | 'finalProgressPercent'
  >,
): string | null => {
  if (entry.objectiveKind === 'temperature') {
    const start = formatTemperature(entry.startProgressC);
    const end = formatTemperature(entry.finalProgressC);
    const target = formatTemperature(entry.targetTemperatureC);
    if (!start || !target) return null;
    return `${start} → ${end ?? '—'}  ·  target ${target}`;
  }
  const start = formatPercent(entry.startProgressPercent);
  const end = formatPercent(entry.finalProgressPercent);
  const target = formatPercent(entry.targetPercent);
  if (!start || !target) return null;
  return `${start} → ${end ?? '—'}  ·  target ${target}`;
};

export const formatPlanHistoryReachedAtLine = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'metAtMs' | 'outcome'>,
  timeZone = 'UTC',
): string | null => {
  if (entry.outcome !== 'met' || entry.metAtMs === null) return null;
  const date = new Date(entry.metAtMs);
  if (Number.isNaN(date.getTime())) return null;
  const timeLabel = formatTimeInTimeZone(date, {
    hour: '2-digit',
    minute: '2-digit',
  }, timeZone);
  return `reached at ${timeLabel}`;
};

const OUTCOME_LABELS: Record<DeferredObjectivePlanOutcome, string> = {
  met: 'Succeeded',
  missed: 'Missed',
  abandoned: 'Abandoned',
  replaced: 'Abandoned',
  unknown: 'Unknown',
};

const OUTCOME_TONES: Record<DeferredObjectivePlanOutcome, DeferredPlanHistoryChipTone> = {
  met: 'ok',
  missed: 'warn',
  abandoned: 'muted',
  replaced: 'muted',
  unknown: 'muted',
};

export const getPlanHistoryOutcomeLabel = (outcome: DeferredObjectivePlanOutcome): string => (
  OUTCOME_LABELS[outcome]
);

export const getPlanHistoryOutcomeTone = (outcome: DeferredObjectivePlanOutcome): DeferredPlanHistoryChipTone => (
  OUTCOME_TONES[outcome]
);

export const shouldShowBackupHoursPill = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'usedPolicyAvoid' | 'usedDeadlineReserve'>,
): boolean => entry.usedPolicyAvoid || entry.usedDeadlineReserve;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const formatDurationMs = (ms: number): string => {
  if (ms <= 0) return '0m';
  // Floor to whole minutes so a sub-hour gap never rounds up across the hour boundary (e.g.
  // 59m 31s must render as "59m", not "1h", to stay consistent with the caller's HOUR_MS
  // threshold for the "Brief gap" / "Not observed for" split).
  const totalMinutes = Math.floor(ms / MINUTE_MS);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

const sumObservedMs = (
  intervals: ReadonlyArray<{ fromMs: number; toMs: number }>,
): number => intervals.reduce((acc, interval) => acc + Math.max(0, interval.toMs - interval.fromMs), 0);

/**
 * Composes a short human-readable explanation for *why* a finalized run was marked missed.
 * Resolves to flat copy from the recorded snapshots so the missed-history surface mirrors the
 * succeeded path's "explanation density": users opening a missed run need to see the cause
 * without inferring from chart bars alone.
 *
 * Branches resolve in priority order (most specific first):
 *  1. Final plan status `cannot_meet` → "PELS couldn't reserve enough energy in time."
 *  2. Final plan status `at_risk`     → "The smart task fell behind and didn't catch up
 *                                       before the deadline."
 *  3. Discovered from backfill        → "PELS was restarted during this smart task —
 *                                       outcome reconstructed from settings."
 *  4. Otherwise                       → "The device did not reach the target before the
 *                                       deadline."
 *
 * Returns `null` only when the entry is not `outcome === 'missed'`; the missed-history page
 * always renders something so the user is never left with a chip and no explanation.
 *
 * Note on the absent "daily budget exhausted" branch: the persisted history
 * snapshot (`DeferredObjectivePlanHistoryRevisionSnapshot`) intentionally
 * drops fields that don't matter retrospectively — including
 * `dailyBudgetExhaustedBucketCount`. Adding it to the snapshot is tracked
 * for v2.7.1 alongside `deliveredKWh` and the revision log (TODO P2). Until
 * then the `cannot_meet` branch absorbs that cause with a recourse-neutral
 * sentence; users see the same explanation on either trigger.
 *
 * Lives in shared-domain so the same strings can feed runtime log breadcrumbs (per
 * `feedback_ui_text_shared_with_logs.md`).
 */
export const formatPlanHistoryMissedReason = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'outcome' | 'originalPlan' | 'finalPlan' | 'discoveredFrom'
  >,
): string | null => {
  if (entry.outcome !== 'missed') return null;
  // Prefer the final plan's status — it reflects the planner's last word
  // before finalization. Fall back to the original snapshot when the run
  // finalized before the planner replanned (no finalPlan recorded).
  const lastPlan = entry.finalPlan ?? entry.originalPlan;
  if (lastPlan?.planStatus === 'cannot_meet') {
    return 'PELS couldn\'t reserve enough energy in time. '
      + 'Try lowering the target or moving the deadline later.';
  }
  if (lastPlan?.planStatus === 'at_risk') {
    return 'The smart task fell behind and didn\'t catch up before the deadline.';
  }
  if (entry.discoveredFrom === 'backfill') {
    return 'PELS was restarted during this smart task — outcome reconstructed from settings.';
  }
  return 'The device did not reach the target before the deadline.';
};

/**
 * Returns a short human-readable note about how complete the observation was for the entry, or
 * `null` if coverage was effectively full (≥99% of the [start, deadline] window). Used by the
 * settings UI to explain entries that may have data gaps (PELS off, diagnostics unavailable).
 */
export const formatPlanHistoryObservedCoverage = (
  entry: Pick<
    DeferredObjectivePlanHistoryEntry,
    'observedIntervals' | 'discoveredFrom' | 'startedAtMs' | 'deadlineAtMs'
  >,
): string | null => {
  if (entry.discoveredFrom === 'backfill') return 'No observations recorded — smart task reconstructed from settings';
  // Entries from older storage or from a test stub that predates the v2 contract may arrive
  // without `observedIntervals`; without this guard the reduce below would throw and crash
  // the surrounding component. Treat missing data as "no coverage info" rather than a hard
  // failure — the contract is enforced at the persistence boundary, not in the renderer.
  if (!Array.isArray(entry.observedIntervals)) return null;
  const windowMs = Math.max(0, entry.deadlineAtMs - entry.startedAtMs);
  if (windowMs < MINUTE_MS) return null;
  const observedMs = Math.min(windowMs, sumObservedMs(entry.observedIntervals));
  const missingMs = Math.max(0, windowMs - observedMs);
  if (missingMs <= Math.max(MINUTE_MS, windowMs * 0.01)) return null;
  if (missingMs >= HOUR_MS) return `Not observed for ${formatDurationMs(missingMs)}`;
  return `Brief gap (${formatDurationMs(missingMs)}) in observation`;
};
