import type { PriceSchemeSetting } from '../../packages/contracts/src/settingsUiApi';

/**
 * What one priced stretch of time says, whatever its length. Neither a period
 * nor an hour on its own — {@link CombinedHourlyPrice} and
 * {@link CombinedPricePeriod} are the two things a producer actually hands out.
 */
export type CombinedPriceFields = {
  startsAt: string;
  totalPrice: number;
  /**
   * Export (feed-in) price for this hour, incl VAT, in the same unit as
   * `totalPrice`. Signed — may be <= 0 under feed-in fees / negative spot.
   * `undefined` when export pricing is disabled. Independent of the import
   * cost stack (carries none of grid tariff / consumption tax / VAT-on-those).
   */
  exportPrice?: number;
  /**
   * Planning price for this hour (a derived coverage-weighted blend of `exportPrice`
   * for the forecast-surplus band and `totalPrice` above it), same unit as
   * `totalPrice`. Drives flexible-load scheduling; `undefined` ⇒ falls back to
   * `totalPrice`. Never used for money/receipts (those stay on `totalPrice`).
   */
  budgetPrice?: number;
  spotPriceExVat?: number;
  gridTariffExVat?: number;
  providerSurchargeExVat?: number;
  consumptionTaxExVat?: number;
  enovaFeeExVat?: number;
  vatMultiplier?: number;
  vatAmount?: number;
  electricitySupportExVat?: number;
  electricitySupport?: number;
  norgesprisAdjustmentExVat?: number;
  norgesprisAdjustment?: number;
  totalExVat?: number;
};

/**
 * One whole hour's price. The shape every hour-shaped consumer takes — the
 * daily budget's buckets, a smart task's claims, the owner's lowest-price Flow
 * cards, the price charts.
 *
 * `durationMinutes?: never` is load-bearing: without it a period series would
 * satisfy this type, and handing 96 quarters to something counting hours
 * compiles clean and miscounts silently. A series only becomes hours by going
 * through `toHourlyPrices`, which is where the duration is dropped.
 */
export type CombinedHourlyPrice = CombinedPriceFields & {
  durationMinutes?: never;
};

/**
 * A combined price for one period as its source published it: an hour on the
 * Norwegian spot feed and on owner-fed Flow prices, a quarter-hour on a Homey
 * Energy zone that has moved to the 15-minute market.
 *
 * Only the price level reads this series — the level answers "what is the price
 * right now", and now is a period. Everything that reasons in whole hours takes
 * {@link CombinedHourlyPrice} from `getCombinedHourlyPrices()` instead.
 */
export type CombinedPricePeriod = CombinedPriceFields & {
  durationMinutes: number;
};

/**
 * Which source prices this home. Declared once, in
 * `packages/contracts/src/settingsUiApi.ts`, because the settings UI renders
 * the same union from the same bytes; the shared read policy for those bytes
 * is `packages/shared-domain/src/settings/priceScheme.ts`.
 */
export type PriceScheme = PriceSchemeSetting;

/** That union's read policy, re-exported beside the type it resolves to. */
export { readPriceSchemeSetting } from '../../packages/shared-domain/src/settings/priceScheme';

export type CombinedPriceEntry = {
  startsAt: string;
  total: number;
  /** Export (feed-in) price, incl VAT, same unit as `total`; signed, may be <= 0; undefined when disabled. */
  exportPrice?: number;
  /** Planning price (derived blend of export + import over the forecast surplus); undefined ⇒ `total`. */
  budgetPrice?: number;
  spotPriceExVat?: number;
  gridTariffExVat?: number;
  providerSurchargeExVat?: number;
  consumptionTaxExVat?: number;
  enovaFeeExVat?: number;
  vatMultiplier?: number;
  vatAmount?: number;
  electricitySupportExVat?: number;
  electricitySupport?: number;
  norgesprisAdjustmentExVat?: number;
  norgesprisAdjustment?: number;
  totalExVat?: number;
  isCheap: boolean;
  isExpensive: boolean;
};

export type CombinedPriceDayEntries = {
  hours: CombinedPriceEntry[];
};

export const COMBINED_PRICES_VERSION = 2 as const;

export type CombinedPricesV2 = {
  version: typeof COMBINED_PRICES_VERSION;
  days: Record<string, CombinedPriceDayEntries>;
  avgPrice: number;
  lowThreshold: number;
  highThreshold: number;
  priceScheme: PriceScheme;
  priceUnit: string;
  thresholdPercent?: number;
  minDiffOre?: number;
  lastFetched?: string;
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isHourEntry = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.startsAt === 'string'
    && isFiniteNumber(record.total)
    && typeof record.isCheap === 'boolean'
    && typeof record.isExpensive === 'boolean';
};

const isDayEntry = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const hours = (value as { hours?: unknown }).hours;
  return Array.isArray(hours) && hours.every(isHourEntry);
};

export const isCombinedPricesV2 = (value: unknown): value is CombinedPricesV2 => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== COMBINED_PRICES_VERSION) return false;
  if (!isFiniteNumber(record.avgPrice)) return false;
  if (!isFiniteNumber(record.lowThreshold) || !isFiniteNumber(record.highThreshold)) return false;
  if (typeof record.priceScheme !== 'string' || typeof record.priceUnit !== 'string') return false;
  if (!record.days || typeof record.days !== 'object' || Array.isArray(record.days)) return false;
  return Object.values(record.days as Record<string, unknown>).every(isDayEntry);
};

/**
 * Pre-V2 shape (`{ prices: [...], avgPrice, lowThreshold, highThreshold,
 * priceScheme, priceUnit, ... }`) persisted in `combined_prices` before
 * `COMBINED_PRICES_VERSION` was introduced. Detected on first read after
 * upgrade so the V1 → V2 migration can run synchronously.
 */
export type CombinedPricesV1 = {
  prices: CombinedPriceEntry[];
  avgPrice: number;
  lowThreshold: number;
  highThreshold: number;
  priceScheme: PriceScheme;
  priceUnit: string;
  thresholdPercent?: number;
  minDiffOre?: number;
  lastFetched?: string;
};

export const isCombinedPricesV1 = (value: unknown): value is CombinedPricesV1 => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // V1 lacks `version` and has a `prices` array; V2 has `version: 2` and `days`.
  if (record.version !== undefined) return false;
  if (!Array.isArray(record.prices)) return false;
  if (!record.prices.every(isHourEntry)) return false;
  if (!isFiniteNumber(record.avgPrice)) return false;
  if (!isFiniteNumber(record.lowThreshold) || !isFiniteNumber(record.highThreshold)) return false;
  return typeof record.priceScheme === 'string' && typeof record.priceUnit === 'string';
};
