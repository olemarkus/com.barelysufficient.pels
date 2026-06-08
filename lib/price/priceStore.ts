import type Homey from 'homey';
import { COMBINED_PRICES } from '../utils/settingsKeys';
import {
  type CombinedPriceEntry,
  type CombinedPricesV2,
  isCombinedPricesV1,
  isCombinedPricesV2,
} from './priceTypes';
import { migrateLegacyCombinedPrices, pruneCombinedPricesV2 } from './priceServiceCombined';
import type { PriceHorizonEntry } from '../../packages/planner-types/src/priceHorizon';

export type PriceStoreDeps = {
  homey: Homey.App['homey'];
  /**
   * Triggered when COMBINED_PRICES is missing or has an unrecognised shape so
   * the coordinator can rebuild from raw scheme data (see
   * PriceCoordinator.updateCombinedPrices). Not invoked for the V1 → V2
   * migration path: V1 already carries every entry, so we migrate in place
   * synchronously. Re-entrant calls within the same read are guarded by
   * `refetchInFlight`.
   */
  requestRefetch: () => void;
};

// Module-scoped re-entrancy guard so a recovery `requestRefetch` call cannot
// recurse if the refetcher itself synchronously triggers another read.
let refetchInFlight = false;

export const __resetRefetchGuardForTest = (): void => {
  refetchInFlight = false;
};

const guardedRequestRefetch = (deps: PriceStoreDeps): void => {
  if (refetchInFlight) return;
  refetchInFlight = true;
  try { deps.requestRefetch(); } finally { refetchInFlight = false; }
};

export const readPriceStore = (deps: PriceStoreDeps, now: Date, timeZone: string): CombinedPricesV2 | null => {
  const raw = deps.homey.settings.get(COMBINED_PRICES) as unknown;
  if (isCombinedPricesV2(raw)) return pruneCombinedPricesV2(raw, now, timeZone);
  // Legacy V1 payload: migrate synchronously so callers see prices immediately
  // instead of a UNKNOWN-price-level gap until the next refetch lands. Persist
  // the V2 form so direct (non-readPriceStore) consumers also see V2 from now
  // on, and so we don't run the migration on every read.
  if (isCombinedPricesV1(raw)) {
    const migrated = migrateLegacyCombinedPrices(raw, now, timeZone);
    deps.homey.settings.set(COMBINED_PRICES, migrated);
    // If the V1 payload had no entries inside the 3-day window (empty
    // legacy.prices, or all entries outside the window), the migrated store
    // is empty and price_level would otherwise stay UNKNOWN until an external
    // refresh arrives. Trigger a refetch so the coordinator rebuilds from
    // raw scheme data.
    if (Object.keys(migrated.days).length === 0) {
      guardedRequestRefetch(deps);
    }
    return migrated;
  }
  // Anything else (truly malformed, foreign shape): drop and ask the
  // coordinator to rebuild. Plain null/undefined is the normal pre-refresh
  // state and not actionable here — the periodic refresher will populate
  // combined_prices on its own.
  if (raw !== null && raw !== undefined) {
    deps.homey.settings.set(COMBINED_PRICES, null);
    guardedRequestRefetch(deps);
  }
  return null;
};

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
 * (`{ prices, lastFetched, priceUnit }`) read out of Homey settings — handles
 * the settings read, the V2 guard, and the flatten in one call.
 */
export const readCombinedPriceData = (
  deps: PriceStoreDeps,
  now: Date,
  timeZone: string,
): { prices?: CombinedPriceEntry[]; lastFetched?: string; priceUnit?: string } | null => (
  combinedPriceDataFromStore(readPriceStore(deps, now, timeZone))
);
