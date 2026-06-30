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

// True when the snapshot recorded the planner's daily-budget cap collapsing
// on at least one bucket in the run-up. The recorder persists positive
// counts only (`captureRevisionSnapshot` filters zeros), so the helper
// treats absence and zero identically — the budget was either not checked
// or was fine. Producer-side resolver so consumers never branch on the raw
// optional field.
export const snapshotShowsBudgetExhausted = (
  snapshot: DeferredObjectivePlanHistoryRevisionSnapshot | null,
): boolean => (
  snapshot !== null
    && typeof snapshot.dailyBudgetExhaustedBucketCount === 'number'
    && snapshot.dailyBudgetExhaustedBucketCount > 0
);

export const pickLastPlan = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'finalPlan' | 'originalPlan'>,
): DeferredObjectivePlanHistoryRevisionSnapshot | null => (
  // Prefer the final plan's status — it reflects the planner's last word
  // before finalization. Fall back to the original snapshot when the run
  // finalized before the planner replanned (no finalPlan recorded).
  entry.finalPlan ?? entry.originalPlan
);
