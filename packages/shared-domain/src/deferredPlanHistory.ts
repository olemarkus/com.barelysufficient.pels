import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanOutcome,
} from '../../contracts/src/deferredObjectivePlanHistory.js';
import { formatDateInTimeZone, formatTimeInTimeZone } from './utils/dateUtils.js';

export type DeferredPlanHistoryChipTone = 'ok' | 'warn' | 'muted';

export const formatPlanHistoryDeadlineLine = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'deadlineAtMs'>,
  timeZone = 'UTC',
): string => {
  const date = new Date(entry.deadlineAtMs);
  if (Number.isNaN(date.getTime())) return 'unknown deadline';
  const dateLabel = formatDateInTimeZone(date, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }, timeZone);
  const timeLabel = formatTimeInTimeZone(date, {
    hour: '2-digit',
    minute: '2-digit',
  }, timeZone);
  return `${dateLabel}  ${timeLabel}`;
};

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
  met: 'Met',
  missed: 'Missed',
  abandoned: 'Stopped',
  replaced: 'Replaced',
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
  if (entry.discoveredFrom === 'backfill') return 'No observations recorded — deadline reconstructed from settings';
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
