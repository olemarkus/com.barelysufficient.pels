import {
  COMBINED_PRICES_VERSION,
  type CombinedHourlyPrice,
  type CombinedPriceDayEntries,
  type CombinedPriceEntry,
  type CombinedPricesV2,
  type PriceScheme,
} from './priceTypes';
import { calculateAveragePrice, calculateThresholds, getPriceLevelFlags } from './priceMath';
import { getDateKeyInTimeZone, shiftDateKey } from '../utils/dateUtils';

export const priceStoreWindowDateKeys = (now: Date, timeZone: string): string[] => {
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  return [shiftDateKey(todayKey, -1), todayKey, shiftDateKey(todayKey, 1)];
};

export const pruneCombinedPricesV2 = (
  store: CombinedPricesV2,
  now: Date,
  timeZone: string,
): CombinedPricesV2 => {
  const window = new Set(priceStoreWindowDateKeys(now, timeZone));
  const days = Object.fromEntries(
    Object.entries(store.days).filter(([key]) => window.has(key)),
  ) as Record<string, CombinedPriceDayEntries>;
  return { ...store, days };
};

const hasNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const buildEntry = (
  source: CombinedHourlyPrice,
  thresholds: { low: number; high: number },
  avgPrice: number,
  minDiffOre: number,
): CombinedPriceEntry => {
  const flags = getPriceLevelFlags({
    price: source.totalPrice,
    avgPrice,
    thresholds,
    minDiff: minDiffOre,
  });
  const base: CombinedPriceEntry = {
    startsAt: source.startsAt,
    total: source.totalPrice,
    isCheap: flags.isCheap,
    isExpensive: flags.isExpensive,
  };
  const extra: Partial<CombinedPriceEntry> = {
    ...(hasNumber(source.spotPriceExVat) ? { spotPriceExVat: source.spotPriceExVat } : {}),
    ...(hasNumber(source.gridTariffExVat) ? { gridTariffExVat: source.gridTariffExVat } : {}),
    ...(hasNumber(source.providerSurchargeExVat)
      ? { providerSurchargeExVat: source.providerSurchargeExVat } : {}),
    ...(hasNumber(source.consumptionTaxExVat) ? { consumptionTaxExVat: source.consumptionTaxExVat } : {}),
    ...(hasNumber(source.enovaFeeExVat) ? { enovaFeeExVat: source.enovaFeeExVat } : {}),
    ...(hasNumber(source.vatMultiplier) ? { vatMultiplier: source.vatMultiplier } : {}),
    ...(hasNumber(source.vatAmount) ? { vatAmount: source.vatAmount } : {}),
    ...(hasNumber(source.electricitySupportExVat)
      ? { electricitySupportExVat: source.electricitySupportExVat } : {}),
    ...(hasNumber(source.electricitySupport) ? { electricitySupport: source.electricitySupport } : {}),
    ...(hasNumber(source.norgesprisAdjustmentExVat)
      ? { norgesprisAdjustmentExVat: source.norgesprisAdjustmentExVat } : {}),
    ...(hasNumber(source.norgesprisAdjustment)
      ? { norgesprisAdjustment: source.norgesprisAdjustment } : {}),
    ...(hasNumber(source.totalExVat) ? { totalExVat: source.totalExVat } : {}),
  };
  return { ...base, ...extra };
};

/* eslint-disable functional/immutable-data --
 * Local accumulator pattern: build a date-keyed bucket of price entries, then
 * sort each bucket by timestamp before returning a frozen-shape result.
 */
const groupEntriesByDateKey = (
  entries: CombinedPriceEntry[],
  timeZone: string,
  windowKeys: Set<string>,
): Record<string, CombinedPriceDayEntries> => {
  const days: Record<string, CombinedPriceEntry[]> = {};
  for (const entry of entries) {
    const ts = new Date(entry.startsAt).getTime();
    if (!Number.isFinite(ts)) continue;
    const dateKey = getDateKeyInTimeZone(new Date(ts), timeZone);
    if (!windowKeys.has(dateKey)) continue;
    const bucket = days[dateKey] ?? [];
    bucket.push(entry);
    days[dateKey] = bucket;
  }
  const out: Record<string, CombinedPriceDayEntries> = {};
  for (const [key, hours] of Object.entries(days)) {
    const sorted = [...hours].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
    out[key] = { hours: sorted };
  }
  return out;
};
/* eslint-enable functional/immutable-data */

export const buildCombinedPricePayload = (params: {
  combined: CombinedHourlyPrice[];
  priceScheme: PriceScheme;
  priceUnit: string;
  thresholdPercent: number;
  minDiffOre: number;
  now: Date;
  timeZone: string;
}): CombinedPricesV2 => {
  const {
    combined,
    priceScheme,
    priceUnit,
    thresholdPercent,
    minDiffOre,
    now,
    timeZone,
  } = params;

  if (combined.length === 0) {
    return {
      version: COMBINED_PRICES_VERSION,
      days: {},
      avgPrice: 0,
      lowThreshold: 0,
      highThreshold: 0,
      priceScheme,
      priceUnit,
    };
  }

  const avgPrice = calculateAveragePrice(combined, (entry) => entry.totalPrice);
  const { low: lowThreshold, high: highThreshold } = calculateThresholds(avgPrice, thresholdPercent);
  const thresholds = { low: lowThreshold, high: highThreshold };
  const entries = combined.map((source) => buildEntry(source, thresholds, avgPrice, minDiffOre));
  const windowKeys = new Set(priceStoreWindowDateKeys(now, timeZone));
  const days = groupEntriesByDateKey(entries, timeZone, windowKeys);

  return {
    version: COMBINED_PRICES_VERSION,
    days,
    avgPrice,
    lowThreshold,
    highThreshold,
    thresholdPercent,
    minDiffOre,
    lastFetched: now.toISOString(),
    priceScheme,
    priceUnit,
  };
};
