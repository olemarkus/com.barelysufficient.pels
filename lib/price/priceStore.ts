import {
  type CombinedPriceEntry,
  type CombinedPricesV2,
} from './priceTypes';
import type { CombinedPricesReader } from './combinedPricesReader';
import type { PriceHorizonEntry } from '../../packages/planner-types/src/priceHorizon';

const PRICE_HORIZON_HOUR_MS = 60 * 60 * 1000;

/**
 * Build the deferred-objective allocation horizon's price source directly from
 * the price layer (`CombinedPricesV2`), independent of the daily-budget
 * snapshot. Flattens the store, filters to hours that overlap
 * `[nowMs, deadlineAtMs)`, dedupes by epoch hour (first-write-wins), and sorts
 * ascending. Returns an empty array when the store is null or no priced hour
 * falls in the window. Lives in the price layer (the producer); the leafward
 * `lib/objectives` consumer only sees the flat `PriceHorizonEntry[]` it returns.
 *
 * `startMs` is the entry's RAW hour-start instant, NOT floored to the epoch
 * hour: this is the price hour's true boundary, so for fractional-offset
 * timezones (local day starts at :30/:45 past the UTC hour) the bucket grid
 * stays phase-aligned with the daily-budget overlay (whose `startUtc` carries
 * the same instants). The epoch-hour floor is used ONLY as the dedupe/join key.
 */
export const buildPriceHorizonFromCombined = (
  store: CombinedPricesV2 | null,
  nowMs: number,
  deadlineAtMs: number,
): PriceHorizonEntry[] => {
  const byHour = new Map<number, PriceHorizonEntry>();
  for (const entry of flattenAllHours(store)) {
    const startMs = new Date(entry.startsAt).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(entry.total)) continue;
    const hourKey = Math.floor(startMs / PRICE_HORIZON_HOUR_MS) * PRICE_HORIZON_HOUR_MS;
    // Overlap test on the price hour `[startMs, startMs + HOUR)`.
    if (startMs + PRICE_HORIZON_HOUR_MS <= nowMs || startMs >= deadlineAtMs) continue;
    // First-write wins: keep the earliest entry that floors to this epoch hour.
    if (!byHour.has(hourKey)) byHour.set(hourKey, { startMs, price: entry.total });
  }
  return [...byHour.values()].sort((left, right) => left.startMs - right.startMs);
};

export const flattenAllHours = (store: CombinedPricesV2 | null): CombinedPriceEntry[] => {
  if (!store) return [];
  const flat = Object.values(store.days).flatMap((day) => day.hours);
  return [...flat].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
};

export const combinedPriceDataFromStore = (
  store: CombinedPricesV2 | null,
): { prices?: CombinedPriceEntry[]; lastFetched?: string; priceUnit?: string } | null => {
  if (!store) return null;
  return {
    prices: flattenAllHours(store),
    lastFetched: store.lastFetched,
    priceUnit: store.priceUnit,
  };
};

/**
 * Convenience for callers that just want the legacy `CombinedPriceData` shape
 * (`{ prices, lastFetched, priceUnit }`) derived from the store — runs the
 * reader's migrating read, then the pure flatten, in one call. No SDK access
 * beyond the injected `reader`.
 */
export const readCombinedPriceData = (
  reader: CombinedPricesReader,
  now: Date,
  timeZone: string,
): { prices?: CombinedPriceEntry[]; lastFetched?: string; priceUnit?: string } | null => (
  combinedPriceDataFromStore(reader.readStore(now, timeZone))
);
