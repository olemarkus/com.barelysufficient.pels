import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../contracts/src/deferredObjectivePlanHistory';
import { formatTimeInTimeZone } from './utils/dateUtils';

// Internal helpers shared between `deferredPlanHistory.ts` (the public entry)
// and `deferredPlanHistoryPostmortem.ts` (the postmortem resolvers extracted to
// keep each file under the 500-effective-line ESLint cap). Kept in a sibling so
// neither consumer has to import the other — that would create a dependency
// cycle (the public entry re-exports the postmortem symbols).

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

// Overshoot threshold matches the `notes/smart-task-ui/README.md` design spec
// ("Notable extras: overshoot line if delivered > target by > 5 °C / 10 %").
// Shared by `formatPlanHistoryOvershootLine` (the dedicated overshoot line) and
// `wasOvershoot` (the postmortem detector) so the two can't drift on the
// threshold definition (5 °C / 10 %).
export const OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC = 5;
export const OVERSHOOT_PERCENT_THRESHOLD_PUBLIC = 10;
// An energy task stands the device down at its target, so the energy fed runs
// over only by the draw between two lifecycle ticks; a kWh past that is worth
// a line.
export const OVERSHOOT_ENERGY_THRESHOLD_KWH_PUBLIC = 1;

export const OVERSHOOT_THRESHOLD_BY_KIND: Record<DeferredObjectiveSettingsKind, number> = {
  temperature: OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC,
  ev_soc: OVERSHOOT_PERCENT_THRESHOLD_PUBLIC,
  energy: OVERSHOOT_ENERGY_THRESHOLD_KWH_PUBLIC,
};

/**
 * A history value in its task's unit: "65.0 °C", "80 %", "9.2 kWh". The one
 * place the history surfaces pick a precision and a suffix per kind.
 */
export const formatHistoryValueForKind = (
  kind: DeferredObjectiveSettingsKind,
  value: number,
): string => {
  switch (kind) {
    case 'temperature': return `${value.toFixed(1)} °C`;
    case 'ev_soc': return `${value.toFixed(0)} %`;
    case 'energy': return `${value.toFixed(1)} kWh`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

export const formatClockTime = (ms: number, timeZone: string): string | null => {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return formatTimeInTimeZone(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }, timeZone);
};

export const pickLastPlan = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'finalPlan' | 'originalPlan'>,
): DeferredObjectivePlanHistoryRevisionSnapshot | null => (
  // Prefer the final plan's status — it reflects the planner's last word
  // before finalization. Fall back to the original snapshot when the run
  // finalized before the planner replanned (no finalPlan recorded).
  entry.finalPlan ?? entry.originalPlan
);
