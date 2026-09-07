import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import {
  getMonthStartInTimeZone,
  getZonedParts,
} from '../utils/dateUtils';
import { DEFAULT_NORGESPRIS_HOURLY_USAGE_ESTIMATE_KWH } from './norwayPriceDefaults';

/**
 * The live power tracker these estimates read: the Main home's in-memory
 * state, handed in by the wiring layer as the typed value it already holds.
 * The price layer never reads it from persistence, and never re-validates it.
 */
export type PowerTrackerReadout = PowerTrackerState;

export const getCurrentMonthUsageKwh = (tracker: PowerTrackerReadout, timeZone: string): number => {
  const now = new Date();
  const monthStartMs = getMonthStartInTimeZone(now, timeZone);
  const { year, month } = getZonedParts(now, timeZone);
  const nextMonthProbe = new Date(Date.UTC(year, month, 15, 12, 0, 0));
  const monthEndMs = getMonthStartInTimeZone(nextMonthProbe, timeZone);
  const hasFiniteMonthEnd = Number.isFinite(monthEndMs);

  let usageKwh = 0;
  const dailyTotals = tracker.dailyTotals;
  const buckets = tracker.buckets;
  if (buckets && typeof buckets === 'object') {
    Object.entries(buckets as Record<string, unknown>).forEach(([isoHour, value]) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const date = new Date(isoHour);
      const ts = date.getTime();
      if (!Number.isFinite(ts)) return;
      if (ts < monthStartMs) return;
      if (hasFiniteMonthEnd && ts >= monthEndMs) return;
      usageKwh += Math.max(0, value); // export hours can persist negative kWh; grid usage can't be negative
    });
  }

  // Daily totals are keyed by YYYY-MM-DD (Homey-local when the runtime can supply a
  // timezone to `aggregateAndPruneHistory`, otherwise legacy UTC). The conservative
  // "fully inside the month window" check works for both: a day-key whose UTC midnight
  // sits inside the local-month UTC window is unambiguously inside that local month.
  if (dailyTotals && typeof dailyTotals === 'object') {
    Object.entries(dailyTotals as Record<string, unknown>).forEach(([dateKey, value]) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const dayStartUtcMs = Date.parse(`${dateKey}T00:00:00.000Z`);
      if (!Number.isFinite(dayStartUtcMs)) return;
      const dayEndUtcMs = dayStartUtcMs + 24 * 60 * 60 * 1000;
      const isFullyInsideMonth = dayStartUtcMs >= monthStartMs
        && (!hasFiniteMonthEnd || dayEndUtcMs <= monthEndMs);
      if (isFullyInsideMonth) {
        usageKwh += Math.max(0, value);
      }
    });
  }

  return usageKwh;
};

export const getHourlyUsageEstimateKwh = (tracker: PowerTrackerReadout): number => {
  const lastPowerW = tracker.lastPowerW;
  if (typeof lastPowerW === 'number' && Number.isFinite(lastPowerW) && lastPowerW > 0) {
    return lastPowerW / 1000;
  }
  return DEFAULT_NORGESPRIS_HOURLY_USAGE_ESTIMATE_KWH;
};
