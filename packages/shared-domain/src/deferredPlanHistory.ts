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
  unknown: 'Unknown',
};

const OUTCOME_TONES: Record<DeferredObjectivePlanOutcome, DeferredPlanHistoryChipTone> = {
  met: 'ok',
  missed: 'warn',
  abandoned: 'muted',
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
