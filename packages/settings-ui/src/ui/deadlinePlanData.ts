import type { SettingsUiBootstrap, SettingsUiPricesPayload } from '../../../contracts/src/settingsUiApi.ts';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import { normalizeCombinedPrices, isFiniteNumber } from './combinedPrices.ts';

export const ONE_HOUR_MS = 60 * 60 * 1000;

export { isFiniteNumber };

export type HorizonHour = {
  startsAtMs: number;
  endMs: number;
  price: number;
  isCheap?: boolean;
  isExpensive?: boolean;
  plannedOtherKWh: number;
};

const getDailyBudgetDayByBucket = (
  dailyBudget: DailyBudgetUiPayload | null,
  startMs: number,
): { day: DailyBudgetDayPayload; index: number } | null => {
  if (!dailyBudget) return null;
  for (const day of Object.values(dailyBudget.days)) {
    const index = day.buckets.startUtc.findIndex((startUtc) => new Date(startUtc).getTime() === startMs);
    if (index >= 0) return { day, index };
  }
  return null;
};

// Chart "Background usage" = `plannedUncontrolledKWh` — the same quantity the
// planner subtracts in `policyHorizon` when sizing each bucket's capacity.
// Per-bucket "other controlled" is unknowable without per-device hourly
// forecasts, and PELS does not model shed-and-admit reshuffling between
// controlled devices at the daily-budget layer.
//
// Legacy daily-budget snapshots that predate the controlled/uncontrolled
// split only have `plannedKWh` (which mixes both). We fall back to that so
// the chart still renders something rather than collapsing the bar to zero;
// the series may slightly over-state background load on such legacy
// snapshots until they roll over.
const resolvePlannedOtherKWh = (
  dailyBudget: DailyBudgetUiPayload | null,
  startMs: number,
): number => {
  const match = getDailyBudgetDayByBucket(dailyBudget, startMs);
  if (!match) return 0;
  const uncontrolled = match.day.buckets.plannedUncontrolledKWh?.[match.index];
  if (isFiniteNumber(uncontrolled)) return Math.max(0, uncontrolled);
  const fallback = match.day.buckets.plannedKWh[match.index];
  return isFiniteNumber(fallback) ? fallback : 0;
};

export const collectHorizonHours = (params: {
  bootstrap: SettingsUiBootstrap;
  deadlineAtMs: number;
  // Hours older than this point are dropped so the chart does not render
  // unrelated history. The runtime planner is the source of truth for the
  // active plan; for a known active plan, callers pass the plan's `startedAtMs`
  // (or `original.revisedAtMs`) so the chart can include past hours within the
  // plan's lifetime. Without an active plan, callers pass `nowMs`.
  windowStartMs: number;
  prices: SettingsUiPricesPayload;
}): HorizonHour[] => (
  normalizeCombinedPrices(params.prices.combinedPrices)
    .map((price) => ({ price, startsAtMs: new Date(price.startsAt).getTime() }))
    .filter(({ startsAtMs }) => Number.isFinite(startsAtMs))
    .map(({ price, startsAtMs }) => ({
      startsAtMs,
      endMs: startsAtMs + ONE_HOUR_MS,
      price: price.total,
      isCheap: price.isCheap,
      isExpensive: price.isExpensive,
      plannedOtherKWh: resolvePlannedOtherKWh(params.bootstrap.dailyBudget, startsAtMs),
    }))
    .filter((hour) => hour.endMs > params.windowStartMs && hour.startsAtMs < params.deadlineAtMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs)
);
