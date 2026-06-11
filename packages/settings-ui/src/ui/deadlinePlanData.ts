import type { SettingsUiPricesPayload } from '../../../contracts/src/settingsUiApi.ts';
import { normalizeCombinedPrices, isFiniteNumber } from './combinedPrices.ts';

export const ONE_HOUR_MS = 60 * 60 * 1000;

export { isFiniteNumber };

export type HorizonHour = {
  startsAtMs: number;
  endMs: number;
  price: number;
  isCheap?: boolean;
  isExpensive?: boolean;
};

export const collectHorizonHours = (params: {
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
    }))
    .filter((hour) => hour.endMs > params.windowStartMs && hour.startsAtMs < params.deadlineAtMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs)
);
