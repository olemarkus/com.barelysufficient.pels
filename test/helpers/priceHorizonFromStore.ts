import { buildPriceHorizonFromPeriods } from '../../lib/price/priceHorizon';
import { flattenAllHours } from '../../lib/price/priceStore';
import type { CombinedPricesV2 } from '../../lib/price/priceTypes';
import type { PriceHorizonEntry } from '../../packages/planner-types/src/priceHorizon';

/** An hourly stored-price fixture as the native-period horizon production builds. */
export const priceHorizonFromStore = (
  store: CombinedPricesV2 | null,
  startMs: number,
  endMs: number,
): PriceHorizonEntry[] => buildPriceHorizonFromPeriods(
  flattenAllHours(store).map(({ total, isCheap: _isCheap, isExpensive: _isExpensive, ...fields }) => ({
    ...fields, totalPrice: total, durationMinutes: 60,
  })),
  startMs,
  endMs,
);
