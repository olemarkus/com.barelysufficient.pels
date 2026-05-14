import {
  formatDeadlineLocalTime,
  type DeferredObjectiveEndedEvent,
  type DeferredObjectivePublicOutcome,
} from '../lib/plan/deferredObjectives';

const PUBLIC_OUTCOME_LABELS: Record<DeferredObjectivePublicOutcome, string> = {
  succeeded: 'Succeeded',
  missed: 'Missed',
  abandoned: 'Abandoned',
};

const formatTemperatureC = (value: number | null): string | null => (
  value === null ? null : `${value.toFixed(1)} °C`
);

const formatPercent = (value: number | null): string | null => (
  value === null ? null : `${value.toFixed(0)} %`
);

const buildEndedTargetText = (event: DeferredObjectiveEndedEvent): string => {
  if (event.objectiveKind === 'temperature') {
    return formatTemperatureC(event.targetTemperatureC) ?? '';
  }
  return formatPercent(event.targetPercent) ?? '';
};

const buildEndedShortfallText = (event: DeferredObjectiveEndedEvent): string => {
  if (event.outcome === 'succeeded') return '';
  if (event.objectiveKind === 'temperature'
    && event.targetTemperatureC !== null
    && event.finalProgressC !== null) {
    const delta = event.targetTemperatureC - event.finalProgressC;
    if (delta > 0) return `${delta.toFixed(1)} °C below target`;
  }
  if (event.objectiveKind === 'ev_soc'
    && event.targetPercent !== null
    && event.finalProgressPercent !== null) {
    const delta = event.targetPercent - event.finalProgressPercent;
    if (delta > 0) return `${delta.toFixed(0)} % below target`;
  }
  return '';
};

export const buildEndedTokens = (
  event: DeferredObjectiveEndedEvent,
  timeZone: string,
): Record<string, unknown> => ({
  device_name: event.deviceName ?? event.deviceId,
  outcome: PUBLIC_OUTCOME_LABELS[event.outcome],
  kind: event.objectiveKind,
  target_text: buildEndedTargetText(event),
  deadline_local_time: formatDeadlineLocalTime(event.deadlineAtMs, timeZone),
  finished_at_local_time: event.outcome === 'succeeded' && event.metAtMs !== null
    ? formatDeadlineLocalTime(event.metAtMs, timeZone)
    : '',
  shortfall_text: buildEndedShortfallText(event),
});

export const normalizeOutcomeArg = (
  raw: unknown,
): DeferredObjectivePublicOutcome | 'any' | null => {
  const id = typeof raw === 'string'
    ? raw
    : (raw as { id?: string } | undefined)?.id ?? '';
  if (id === 'any' || id === 'succeeded' || id === 'missed' || id === 'abandoned') return id;
  return null;
};
