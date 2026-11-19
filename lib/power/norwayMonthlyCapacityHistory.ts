import { getDateKeyInTimeZone, getDateKeyStartMs } from '../../packages/shared-domain/src/utils/dateUtils';
import type { NorwayCapacityDailyPeak } from '../../packages/contracts/src/norwayMonthlyCapacity';
import type { PowerTrackerState } from './trackerTypes';

export const NORWAY_BILLING_ZONE = 'Europe/Oslo';
const HOUR_MS = 3_600_000;

/** A read projection of the retained hourly usage, never a second measurement tracker. */
export type NorwayMonthHistory = {
  readonly monthKey: string;
  readonly peaks: readonly NorwayCapacityDailyPeak[];
  /** Availability of recorded hours, not proof of billing-meter sample duration. */
  readonly coverage: 'complete' | 'partial';
};

export const norwayMonthKey = (atMs: number): string => (
  getDateKeyInTimeZone(new Date(atMs), NORWAY_BILLING_ZONE).slice(0, 7)
);

const hasEveryHour = (hours: ReadonlySet<number>, firstHour: number, currentHour: number): boolean => {
  for (let hour = firstHour; hour <= currentHour; hour += HOUR_MS) {
    if (!hours.has(hour)) return false;
  }
  return true;
};

const validHistoryHour = (hour: number): boolean => Number.isFinite(hour) && hour % HOUR_MS === 0;
const validHistoryValue = (kw: number): boolean => Number.isFinite(kw) && kw >= 0;

const retainsPeak = (previous: NorwayCapacityDailyPeak | undefined, kw: number, hour: number): boolean => (
  previous !== undefined && (previous.kw > kw || (previous.kw === kw && previous.hourStartMs <= hour))
);

/**
 * The same clamped-import kWh buckets Usage displays. Each full hour's kWh is
 * its average kW; the current hour's recorded energy is only a lower bound.
 * Missing and suspect hours never become invented zeroes or recorded duration.
 */
export const projectNorwayMonthHistory = (tracker: PowerTrackerState, nowMs: number): NorwayMonthHistory => {
  const monthKey = norwayMonthKey(nowMs);
  const firstHour = getDateKeyStartMs(`${monthKey}-01`, NORWAY_BILLING_ZONE);
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const hours = new Set<number>();
  const daily = new Map<string, NorwayCapacityDailyPeak>();
  let invalid = false;
  for (const [key, kw] of Object.entries(tracker.buckets ?? {})) {
    const hour = Date.parse(key);
    if (!validHistoryHour(hour)) { invalid = true; continue; }
    if (hour < firstHour || hour > currentHour) continue;
    if (!validHistoryValue(kw)) { invalid = true; continue; }
    hours.add(hour);
    const dateKey = getDateKeyInTimeZone(new Date(hour), NORWAY_BILLING_ZONE);
    const previous = daily.get(dateKey);
    if (retainsPeak(previous, kw, hour)) continue;
    const peak: NorwayCapacityDailyPeak = hour === currentHour
      ? { dateKey, hourStartMs: hour, kw, lowerBound: true } : { dateKey, hourStartMs: hour, kw };
    daily.set(dateKey, peak);
  }
  const unreliable = tracker.unreliablePeriods?.some((period) => period.end > firstHour && period.start < nowMs);
  return {
    monthKey, peaks: [...daily.values()],
    coverage: !invalid && !unreliable && hours.size > 0
      && hasEveryHour(hours, firstHour, currentHour - HOUR_MS) ? 'complete' : 'partial',
  };
};
