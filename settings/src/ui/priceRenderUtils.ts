import type { CombinedPriceData, PriceEntry } from './priceTypes';
import {
  formatDateInTimeZone,
  getDateKeyInTimeZone,
  getDateKeyStartMs,
} from './timezone';
import { calculateThresholds } from './priceThresholds';

export type PriceScheme = 'norway' | 'flow' | 'homey';

export const resolvePriceScheme = (data: CombinedPriceData): PriceScheme => (
  data.priceScheme === 'flow' || data.priceScheme === 'homey' ? data.priceScheme : 'norway'
);

export const resolvePriceUnit = (data: CombinedPriceData, scheme: PriceScheme): string => {
  if (scheme === 'norway') return data.priceUnit || 'øre/kWh';
  const unit = typeof data.priceUnit === 'string' ? data.priceUnit : '';
  return unit === 'price units' ? '' : unit;
};

const formatPriceValue = (value: number, decimals: number): string => (
  value.toFixed(decimals)
);

const isExternalScheme = (scheme: PriceScheme): boolean => scheme !== 'norway';

export const formatSummaryPrice = (value: number, scheme: PriceScheme): string => (
  formatPriceValue(value, isExternalScheme(scheme) ? 4 : 0)
);

export const formatChipPrice = (value: number, scheme: PriceScheme): string => (
  formatPriceValue(value, isExternalScheme(scheme) ? 4 : 1)
);

export const formatPriceWithUnit = (value: string, unit: string): string => (
  unit ? `${value} ${unit}` : value
);

export const getAverageTotal = (prices: PriceEntry[], fallback: number): number => {
  if (prices.length === 0) return fallback;
  let sum = 0;
  let count = 0;
  prices.forEach((price) => {
    if (Number.isFinite(price.total)) {
      sum += price.total;
      count += 1;
    }
  });
  return count > 0 ? sum / count : fallback;
};

export type TimedStartEntry<T extends { startsAt?: string }> = {
  entry: T;
  timestamp: number;
};

export const sortEntriesByStart = <T extends { startsAt?: string }>(
  entries: T[],
): TimedStartEntry<T>[] => (
  entries
    .flatMap((entry) => {
      if (typeof entry.startsAt !== 'string') return [];
      const timestamp = new Date(entry.startsAt).getTime();
      if (!Number.isFinite(timestamp)) return [];
      return [{ entry, timestamp }];
    })
    .sort((a, b) => a.timestamp - b.timestamp)
);

const buildDayLabel = (dateKey: string, todayKey: string, timeZone: string): string => {
  if (dateKey === todayKey) return 'Today';
  const dayStart = new Date(getDateKeyStartMs(dateKey, timeZone));
  return formatDateInTimeZone(dayStart, { weekday: 'short', month: 'short', day: 'numeric' }, timeZone);
};

export const groupPricesByDate = (prices: PriceEntry[], timeZone: string) => {
  const entriesByDate = new Map<string, PriceEntry[]>();
  prices.forEach((entry) => {
    const entryTime = new Date(entry.startsAt);
    if (Number.isNaN(entryTime.getTime())) return;
    const key = getDateKeyInTimeZone(entryTime, timeZone);
    const existing = entriesByDate.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      entriesByDate.set(key, [entry]);
    }
  });
  const dayKeys = Array.from(entriesByDate.keys()).sort();
  return { entriesByDate, dayKeys };
};

export const selectDayEntries = (params: {
  entriesByDate: Map<string, PriceEntry[]>;
  dayKeys: string[];
  todayKey: string;
  timeZone: string;
}) => {
  const {
    entriesByDate,
    dayKeys,
    todayKey,
    timeZone,
  } = params;
  const primaryKey = dayKeys.includes(todayKey) ? todayKey : (dayKeys[0] ?? todayKey);
  const secondaryKey = dayKeys.find((key) => key !== primaryKey) ?? null;
  const primaryEntries = (entriesByDate.get(primaryKey) ?? []).slice();
  const secondaryEntries = secondaryKey ? (entriesByDate.get(secondaryKey) ?? []).slice() : [];
  const primaryLabel = buildDayLabel(primaryKey, todayKey, timeZone);
  const secondaryLabel = secondaryKey ? buildDayLabel(secondaryKey, todayKey, timeZone) : null;
  return {
    primaryEntries,
    secondaryEntries,
    primaryLabel,
    secondaryLabel,
  };
};

export const resolveThresholds = (data: CombinedPriceData): { lowThreshold: number; highThreshold: number } => {
  const thresholdPct = data.thresholdPercent ?? 25;
  const derivedThresholds = calculateThresholds(data.avgPrice, thresholdPct);
  const baseLowThreshold = Number.isFinite(data.lowThreshold)
    ? data.lowThreshold
    : derivedThresholds.low;
  const baseHighThreshold = Number.isFinite(data.highThreshold)
    ? data.highThreshold
    : derivedThresholds.high;
  const minDiff = typeof data.minDiffOre === 'number' && Number.isFinite(data.minDiffOre)
    ? data.minDiffOre
    : 0;
  const lowThreshold = minDiff > 0
    ? Math.min(baseLowThreshold, data.avgPrice - minDiff)
    : baseLowThreshold;
  const highThreshold = minDiff > 0
    ? Math.max(baseHighThreshold, data.avgPrice + minDiff)
    : baseHighThreshold;
  return { lowThreshold, highThreshold };
};
