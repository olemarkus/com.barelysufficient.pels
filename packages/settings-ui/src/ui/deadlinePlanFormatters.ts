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

// Always one decimal (65.0 °C), matching shared-domain's
// `formatProgressValueForUnit`, so the hero's current/target lines and the
// trajectory/target labels never show the same figure at two precisions.
export const formatTemperature = (value: number): string => (
  `${value.toFixed(1)} °C`
);

export const formatTarget = (objective: DeferredObjectiveSettingsEntry): string => (
  objective.kind === 'temperature'
    ? formatTemperature(objective.targetTemperatureC)
    : `${objective.targetPercent}%`
);

// Browser-side locale-aware short timestamp used by the stale-fallback branch
// of `formatLastSampleValue`. Lives in this shared formatter module so the
// producer (`deadlinePlanInputs.ts`) and the React view (`PlanInputsCard` in
// `views/DeadlinePlan.tsx`) can both import it without setting up a cycle
// between `deadlinePlanInputs.ts` and `views/DeadlinePlan.tsx` — they already
// communicate through the `DeadlinePlanPayload` type, and the view needs the
// same `formatAcceptedAt` to re-derive the stale-fallback row text on its
// 60s freshness tick.
export const formatAcceptedAt = (ms: number): string => {
  const date = new Date(ms);
  // Locale-aware short timestamp. Browser-side, so the user's runtime locale
  // and timezone are applied automatically — no `timeZone` plumbing required.
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};
