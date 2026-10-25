import type { FlowPricePayload } from '../../packages/shared-domain/src/price/flowPriceUtils';
import { getDateKeyInTimeZone, shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';
import { COMBINED_PRICES, FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW, PRICE_SCHEME } from '../../lib/utils/settingsKeys';
import { buildCombinedPricePayload } from '../../lib/price/priceServiceCombined';
import { mockHomeyInstance } from '../mocks/homey';

/** Seed a published hourly source through the SDK settings imported at boot. */
export const seedHourlyFlowPricesForTests = (startMs: number, prices: readonly number[]): void => {
  const timeZone = mockHomeyInstance.clock.getTimezone();
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const periods = prices.map((totalPrice, index) => ({
    startsAt: new Date(startMs + index * 3_600_000).toISOString(),
    totalPrice,
    durationMinutes: 60,
  }));
  mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
  for (const [offset, key] of [FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW].entries()) {
    const dateKey = shiftDateKey(todayKey, offset);
    const pricesBySlot = periods.filter((period) => getDateKeyInTimeZone(new Date(period.startsAt), timeZone) === dateKey);
    if (pricesBySlot.length === 0) continue;
    const payload: FlowPricePayload = { dateKey, pricesByHour: {}, pricesBySlot, updatedAt: new Date().toISOString() };
    mockHomeyInstance.settings.set(key, payload);
  }
  // Budgets still read the persisted hourly projection at boot. Build it from
  // the same source values, while Smart tasks consume the native Flow slots.
  mockHomeyInstance.settings.set(COMBINED_PRICES, buildCombinedPricePayload({
    combined: periods.map(({ startsAt, totalPrice }) => ({ startsAt, totalPrice })),
    priceScheme: 'flow',
    priceUnit: 'price units',
    thresholdPercent: 25,
    minDiffOre: 0,
    now: new Date(),
    timeZone,
  }));
};
