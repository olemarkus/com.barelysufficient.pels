// Permissive normalizer for the settings-UI `combinedPrices` payload.
//
// The Homey backend has shipped at least three shapes over the lifetime of the
// price endpoint:
//   1. Flat array of `{ startsAt, total | totalPrice, isCheap?, isExpensive? }`.
//   2. `{ prices: […] }` wrapping the flat array.
//   3. `{ days: { 'YYYY-MM-DD': { hours: […] } } }` keyed by local date.
//
// Both `deadlinePlanData.ts` (horizon chart) and `PlanHero.tsx`
// (anticipation subline) need to consume this payload, so the normalizer is
// extracted here to avoid drift between two ad-hoc reimplementations.
//
// Output is a flat array of rows with `total` already resolved (preferring
// `total` over the legacy `totalPrice`) and `exportPrice` / `budgetPrice` /
// `isCheap` / `isExpensive` carried through when present (numbers finite-gated).
// Entries lacking a finite numeric total or a string `startsAt` are dropped
// silently.

import { isFiniteNumber } from '../../../shared-domain/src/numberGuards.ts';

const isRecord = (candidate: unknown): candidate is Record<string, unknown> => (
  Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
);

export type CombinedPriceRow = {
  startsAt: string;
  total: number;
  // Export (feed-in) price for the hour — signed (negative = the home pays to
  // export) and in the same unit as `total`. Absent when export pricing is off.
  exportPrice?: number;
  // Planning price the schedulers use (derived blend of export + import over
  // the forecast surplus). Absent ⇒ falls back to `total`.
  budgetPrice?: number;
  isCheap?: boolean;
  isExpensive?: boolean;
};

type CombinedPricesShape = {
  prices?: unknown;
  days?: unknown;
};

export const normalizeCombinedPrices = (combined: unknown): CombinedPriceRow[] => {
  let entries: unknown[] = [];
  if (Array.isArray(combined)) {
    entries = combined;
  } else if (isRecord(combined)) {
    const days = (combined as CombinedPricesShape).days;
    if (isRecord(days)) {
      entries = Object.values(days).flatMap((day) => (
        isRecord(day) && Array.isArray((day as { hours?: unknown }).hours)
          ? (day as { hours: unknown[] }).hours
          : []
      ));
    } else if (Array.isArray((combined as CombinedPricesShape).prices)) {
      entries = (combined as CombinedPricesShape).prices as unknown[];
    }
  }
  return entries.flatMap<CombinedPriceRow>((entry) => {
    if (!isRecord(entry) || typeof entry.startsAt !== 'string') return [];
    let total: number | null = null;
    if (isFiniteNumber(entry.total)) total = entry.total;
    else if (isFiniteNumber(entry.totalPrice)) total = entry.totalPrice;
    if (total === null) return [];
    return [{
      startsAt: entry.startsAt,
      total,
      // Finite-gated like `total`: a malformed export/planning price is dropped
      // (field absent), never carried inward as NaN/Infinity.
      ...(isFiniteNumber(entry.exportPrice) ? { exportPrice: entry.exportPrice } : {}),
      ...(isFiniteNumber(entry.budgetPrice) ? { budgetPrice: entry.budgetPrice } : {}),
      ...(entry.isCheap === true ? { isCheap: true } : {}),
      ...(entry.isExpensive === true ? { isExpensive: true } : {}),
    }];
  });
};
