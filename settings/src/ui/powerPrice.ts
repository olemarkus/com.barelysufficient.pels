import type { CombinedPriceData, PriceEntry } from './priceTypes';

type PriceAtHour = {
  total: number;
  isCheap: boolean;
  isExpensive: boolean;
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const getPriceUnit = (data: CombinedPriceData): string | undefined => {
  if (typeof data.priceUnit === 'string' && data.priceUnit.trim()) {
    return data.priceUnit;
  }
  return data.priceScheme === 'norway' || typeof data.priceScheme !== 'string'
    ? 'ore/kWh'
    : undefined;
};

export const buildPriceByHour = (data: CombinedPriceData | null): {
  byHour: Map<number, PriceAtHour>;
  unit: string | undefined;
} => {
  const byHour = new Map<number, PriceAtHour>();
  if (!data || !Array.isArray(data.prices)) {
    return { byHour, unit: undefined };
  }
  data.prices.forEach((entry: PriceEntry) => {
    if (typeof entry.startsAt !== 'string' || !isFiniteNumber(entry.total)) return;
    const timestamp = new Date(entry.startsAt).getTime();
    if (!Number.isFinite(timestamp)) return;
    byHour.set(timestamp, {
      total: entry.total,
      isCheap: entry.isCheap === true,
      isExpensive: entry.isExpensive === true,
    });
  });
  return { byHour, unit: getPriceUnit(data) };
};
