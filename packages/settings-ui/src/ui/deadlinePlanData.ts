import type { SettingsUiPricesPayload } from '../../../contracts/src/settingsUiApi.ts';
import { resolvePlanningPrice } from '../../../shared-domain/src/price/planningPrice.ts';
import { normalizeCombinedPrices, isFiniteNumber } from './combinedPrices.ts';

export const ONE_HOUR_MS = 60 * 60 * 1000;

export { isFiniteNumber };

export type HorizonHour = {
  startsAtMs: number;
  endMs: number;
  // Import price (`total`) — the MONEY basis. The hero's delivered/planned cost
  // lines reconcile to the bill, so they must stay on this (see
  // `resolveLiveCostAndDelivery` in `deadlinePlan.ts`).
  price: number;
  // Planning price (`budgetPrice ?? total`) — the DISPLAY basis for the
  // schedule chart, its readout, and the trust caption, so the "at what price"
  // timeline follows the same signal the scheduler picked hours on. Equals
  // `price` for a non-prosumer (byte-identical).
  planningPrice: number;
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
      planningPrice: resolvePlanningPrice(price.budgetPrice, price.total),
      isCheap: price.isCheap,
      isExpensive: price.isExpensive,
    }))
    .filter((hour) => hour.endMs > params.windowStartMs && hour.startsAtMs < params.deadlineAtMs)
    .sort((left, right) => left.startsAtMs - right.startsAtMs)
);
