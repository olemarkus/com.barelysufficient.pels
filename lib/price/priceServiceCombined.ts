import {
  COMBINED_PRICES_VERSION,
  isCombinedPricesV1,
  isCombinedPricesV2,
  type CombinedHourlyPrice,
  type CombinedPriceDayEntries,
  type CombinedPriceEntry,
  type CombinedPricesV1,
  type CombinedPricesV2,
  type PriceScheme,
} from './priceTypes';
import { calculateAveragePrice, calculateThresholds, getPriceLevelFlags } from './priceMath';
import { getDateKeyInTimeZone, shiftDateKey } from '../utils/dateUtils';
import { toStableFingerprint } from '../utils/stableFingerprint';

const stripLastFetched = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'lastFetched')) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'lastFetched'));
};

/** Stable structural fingerprint of a combined-prices payload, ignoring `lastFetched`. */
export const toCombinedPayloadFingerprint = (value: unknown): string => (
  toStableFingerprint(stripLastFetched(value))
);

export const getCombinedPayloadLastFetched = (value: unknown): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lastFetched = (value as { lastFetched?: unknown }).lastFetched;
  return typeof lastFetched === 'string' ? lastFetched : null;
};

export const priceStoreWindowDateKeys = (now: Date, timeZone: string): string[] => {
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  return [shiftDateKey(todayKey, -1), todayKey, shiftDateKey(todayKey, 1)];
};

/**
 * Decide whether a boot-time combined-prices rotation is warranted. Returns
 * true only when the persisted payload's `lastFetched` resolves to an earlier
 * local day than `now`. A missing payload, missing/non-string `lastFetched`,
 * or unparseable timestamp returns false so we never rotate (or clobber state)
 * on a transient/empty SDK read. Comparison is on the tz-aware date *key*, not
 * raw millisecond deltas, so DST 23/25-hour days do not skew the boundary.
 */
export const shouldCatchUpCombinedPricesRotation = (
  existingPayload: unknown,
  now: Date,
  timeZone: string,
): boolean => {
  if (!existingPayload || typeof existingPayload !== 'object' || Array.isArray(existingPayload)) {
    return false;
  }
  const lastFetched = (existingPayload as { lastFetched?: unknown }).lastFetched;
  if (typeof lastFetched !== 'string') return false;
  const lastFetchedDate = new Date(lastFetched);
  if (Number.isNaN(lastFetchedDate.getTime())) return false;
  // Date keys are zero-padded YYYY-MM-DD, so lexical `<` is chronological.
  // Strictly-earlier only: a future-dated payload (clock/NTP skew) must not rotate.
  return getDateKeyInTimeZone(lastFetchedDate, timeZone) < getDateKeyInTimeZone(now, timeZone);
};

/**
 * True when a persisted `combined_prices` payload carries at least one *actionable*
 * hourly price entry — i.e. an entry whose local-day key is today or tomorrow.
 *
 * Used as a data-safety guard: a missing/transiently-unreadable/invalid raw flow
 * slot makes the combined rebuild empty, and overwriting the cache with that empty
 * payload would wipe still-valid prices. We only protect today/tomorrow entries:
 * yesterday's prices aging out of the cache is normal rotation, not a transient
 * read, so a cache holding only stale (out-of-window) entries is fair to clear.
 */
export const combinedPayloadHasActionablePriceEntries = (
  value: unknown,
  now: Date,
  timeZone: string,
): boolean => {
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  if (isCombinedPricesV2(value)) {
    const today = value.days[todayKey]?.hours ?? [];
    const tomorrow = value.days[tomorrowKey]?.hours ?? [];
    return today.length > 0 || tomorrow.length > 0;
  }
  if (isCombinedPricesV1(value)) {
    return value.prices.some((entry) => {
      const key = getDateKeyInTimeZone(new Date(entry.startsAt), timeZone);
      return key === todayKey || key === tomorrowKey;
    });
  }
  return false;
};

/**
 * True when a freshly-built combined payload has lost the today/tomorrow prices
 * the existing cache still holds — i.e. the rebuild went empty (or lost the
 * actionable window) while the cache is still populated. Signals a transient /
 * missing / invalid raw-slot read; the caller must keep the cache rather than
 * clobber it. Yesterday-only caches aging out are ignored (normal rotation).
 */
export const combinedRebuildLostActionableEntries = (
  existing: unknown,
  next: unknown,
  now: Date,
  timeZone: string,
): boolean => (
  !combinedPayloadHasActionablePriceEntries(next, now, timeZone)
  && combinedPayloadHasActionablePriceEntries(existing, now, timeZone)
);

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

/**
 * Convert a legacy V1 `combined_prices` payload (`{ prices: [...], avgPrice,
 * ... }`) into the date-keyed V2 shape, applying the rolling 3-day window.
 * The V1 entries already carry the resolved `total`, `isCheap`, `isExpensive`
 * fields, so no recomputation against thresholds is needed — we just regroup.
 */
export const migrateLegacyCombinedPrices = (
  legacy: CombinedPricesV1,
  now: Date,
  timeZone: string,
): CombinedPricesV2 => {
  const windowKeys = new Set(priceStoreWindowDateKeys(now, timeZone));
  const days = groupEntriesByDateKey(legacy.prices, timeZone, windowKeys);
  const base: CombinedPricesV2 = {
    version: COMBINED_PRICES_VERSION,
    days,
    avgPrice: legacy.avgPrice,
    lowThreshold: legacy.lowThreshold,
    highThreshold: legacy.highThreshold,
    priceScheme: legacy.priceScheme,
    priceUnit: legacy.priceUnit,
  };
  const extra: Partial<CombinedPricesV2> = {
    ...(typeof legacy.thresholdPercent === 'number' && Number.isFinite(legacy.thresholdPercent)
      ? { thresholdPercent: legacy.thresholdPercent } : {}),
    ...(typeof legacy.minDiffOre === 'number' && Number.isFinite(legacy.minDiffOre)
      ? { minDiffOre: legacy.minDiffOre } : {}),
    ...(typeof legacy.lastFetched === 'string' ? { lastFetched: legacy.lastFetched } : {}),
  };
  return { ...base, ...extra };
};
