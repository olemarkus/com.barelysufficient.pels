import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';

export const formatHourLabel = (startsAtMs: number): string => (
  new Date(startsAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
);

export const formatDeadlineFull = (deadlineAtMs: number): string => (
  new Date(deadlineAtMs).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
);

export const formatDeadlineShort = (deadlineAtMs: number): string => (
  new Date(deadlineAtMs).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  })
);

export const formatTemperature = (value: number): string => (
  Number.isInteger(value) ? `${value} °C` : `${value.toFixed(1)} °C`
);

export const formatTarget = (objective: DeferredObjectiveSettingsEntry): string => (
  objective.kind === 'temperature'
    ? formatTemperature(objective.targetTemperatureC)
    : `${objective.targetPercent}%`
);
