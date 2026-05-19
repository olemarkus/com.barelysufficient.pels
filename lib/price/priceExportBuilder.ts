import type { CombinedPriceEntry, CombinedPricesV2 } from './priceTypes';
import { getDateKeyInTimeZone, getDateKeyStartMs, shiftDateKey } from '../utils/dateUtils';
import type { PriceExportV1 } from '../../packages/contracts/src/priceExport';

export type PriceExportBuilderInput = {
  store: CombinedPricesV2 | null;
  now: Date;
  timeZone: string;
};

const HOUR_MS = 60 * 60 * 1000;

// Build a length-N array indexed by local hour (24, or 23/25 on DST days),
// with `null` in any slot for which the source data is missing — sparse Flow /
// Homey inputs are explicitly allowed and consumers must be able to read the
// price for a given hour by index without later hours shifting left.
const hourAlignedTotals = (
  entries: CombinedPriceEntry[],
  dateKey: string,
  timeZone: string,
): (number | null)[] => {
  const dayStartMs = getDateKeyStartMs(dateKey, timeZone);
  const nextDayStartMs = getDateKeyStartMs(shiftDateKey(dateKey, 1), timeZone);
  const hourCount = Math.max(1, Math.round((nextDayStartMs - dayStartMs) / HOUR_MS));
  const totalByIndex = new Map<number, number>();
  for (const entry of entries) {
    const entryMs = new Date(entry.startsAt).getTime();
    if (!Number.isFinite(entryMs)) continue;
    const index = Math.floor((entryMs - dayStartMs) / HOUR_MS);
    if (index < 0 || index >= hourCount) continue;
    totalByIndex.set(index, entry.total);
  }
  return Array.from({ length: hourCount }, (_, index) => totalByIndex.get(index) ?? null);
};

export const buildPriceExport = (input: PriceExportBuilderInput): PriceExportV1 => {
  const { store, now, timeZone } = input;
  const todayKey = getDateKeyInTimeZone(now, timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  // `[]` is the "no published hours yet" signal — used for tomorrow before
  // day-ahead arrives, and for today before the first refresh has run. Only
  // emit a hour-aligned array once there is at least one published hour.
  const todayEntries = store?.days[todayKey]?.hours ?? [];
  const tomorrowEntries = store?.days[tomorrowKey]?.hours ?? [];
  return {
    today: todayEntries.length === 0
      ? []
      : hourAlignedTotals(todayEntries, todayKey, timeZone),
    tomorrow: tomorrowEntries.length === 0
      ? []
      : hourAlignedTotals(tomorrowEntries, tomorrowKey, timeZone),
    unit: store?.priceUnit ?? 'price units',
  };
};

/** Stable string for detecting meaningful changes between publishes. */
export const priceExportFingerprint = (exportValue: PriceExportV1): string => (
  JSON.stringify(exportValue)
);
