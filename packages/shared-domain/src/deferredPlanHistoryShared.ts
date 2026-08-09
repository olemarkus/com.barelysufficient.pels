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

// True when the snapshot recorded the soft daily budget as what bound the
// planner's floor. Two shapes answer that, and BOTH must be honoured:
//
//   - `floorShortfallCause === 'budget'` — what every newly finalized entry
//     carries. The hour's own share of the budget is what the floor could not
//     clear.
//   - a positive `dailyBudgetExhaustedBucketCount` — the RETIRED signal, still
//     present on history an older build persisted. Kept so a run finalized
//     before the upgrade keeps its attribution instead of silently
//     reclassifying as a device or schedule problem.
//
// Producer-side resolver so consumers never branch on either raw optional
// field. Load-bearing beyond the history UI: `deadlineMissedToBudgetOnDay`
// censors a budget-caused miss out of the weather energy-signature fit, so a
// false negative here feeds a deliberately-withheld day into the model that
// auto-applies daily budgets.
export const snapshotShowsBudgetExhausted = (
  snapshot: DeferredObjectivePlanHistoryRevisionSnapshot | null,
): boolean => {
  if (snapshot === null) return false;
  if (snapshot.floorShortfallCause === 'budget') return true;
  return typeof snapshot.dailyBudgetExhaustedBucketCount === 'number'
    && snapshot.dailyBudgetExhaustedBucketCount > 0;
};

export const pickLastPlan = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'finalPlan' | 'originalPlan'>,
): DeferredObjectivePlanHistoryRevisionSnapshot | null => (
  // Prefer the final plan's status — it reflects the planner's last word
  // before finalization. Fall back to the original snapshot when the run
  // finalized before the planner replanned (no finalPlan recorded).
  entry.finalPlan ?? entry.originalPlan
);
