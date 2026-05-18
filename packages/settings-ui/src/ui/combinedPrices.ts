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
// `total` over the legacy `totalPrice`) and `isCheap` / `isExpensive` carried
// through when present. Entries lacking a finite numeric total or a string
// `startsAt` are dropped silently.

const isRecord = (candidate: unknown): candidate is Record<string, unknown> => (
  Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
);

// Settings-UI-side `isFiniteNumber`. The runtime backend has its own copy in
// `lib/utils/appTypeGuards.ts`, but architecture rules forbid the settings UI
// from importing runtime code, so this lives here as the canonical settings-UI
// source. `deadlinePlanData.ts` re-imports from this module to avoid drift.
export const isFiniteNumber = (candidate: unknown): candidate is number => (
  typeof candidate === 'number' && Number.isFinite(candidate)
);

export type CombinedPriceRow = {
  startsAt: string;
  total: number;
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
      ...(entry.isCheap === true ? { isCheap: true } : {}),
      ...(entry.isExpensive === true ? { isExpensive: true } : {}),
    }];
  });
};
