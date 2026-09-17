import { getZonedParts } from '../utils/dateUtils';
import type { CapacityMonthlyPeak, CapacityQuarter } from './trackerTypes';
import { CAPACITY_QUARTER_MS } from '../../packages/shared-domain/src/settings/capacityPeriod';

export type CapacityQuarterTracking = {
  quarter: CapacityQuarter;
  monthlyPeak: CapacityMonthlyPeak | undefined;
};

const quarterStart = (atMs: number): number => Math.floor(atMs / CAPACITY_QUARTER_MS) * CAPACITY_QUARTER_MS;

const monthKeyAt = (atMs: number, timeZone: string): string => {
  const { year, month } = getZonedParts(new Date(atMs), timeZone);
  return `${year}-${String(month).padStart(2, '0')}`;
};

export const startCapacityQuarterTracking = (atMs: number): CapacityQuarter => ({
  startMs: quarterStart(atMs),
  energyKWh: 0,
  trackedMs: 0,
});

const includeCompletedQuarter = (
  monthlyPeak: CapacityMonthlyPeak | undefined,
  quarter: CapacityQuarter,
  timeZone: string,
): CapacityMonthlyPeak | undefined => {
  if (quarter.trackedMs < CAPACITY_QUARTER_MS) return monthlyPeak;
  const monthKey = monthKeyAt(quarter.startMs, timeZone);
  const peakKw = quarter.energyKWh * 4;
  return monthlyPeak?.monthKey === monthKey
    ? { monthKey, peakKw: Math.max(monthlyPeak.peakKw, peakKw) }
    : { monthKey, peakKw };
};

/**
 * Accrue the held whole-home import sample into aligned tariff quarters.
 * Only the active quarter and the local month's maximum are retained.
 */
export const accrueCapacityQuarter = (
  previousQuarter: CapacityQuarter | undefined,
  previousMonthlyPeak: CapacityMonthlyPeak | undefined,
  startMs: number,
  endMs: number,
  powerW: number,
  timeZone: string,
): CapacityQuarterTracking => {
  let quarter = previousQuarter?.startMs === quarterStart(startMs)
    ? previousQuarter
    : startCapacityQuarterTracking(startMs);
  let monthlyPeak = previousMonthlyPeak;
  let cursorMs = startMs;

  while (cursorMs < endMs) {
    const endOfQuarterMs = quarter.startMs + CAPACITY_QUARTER_MS;
    const segmentMs = Math.min(endMs, endOfQuarterMs) - cursorMs;
    quarter = {
      startMs: quarter.startMs,
      energyKWh: quarter.energyKWh + (Math.max(0, powerW) / 1000) * (segmentMs / 3_600_000),
      trackedMs: quarter.trackedMs + segmentMs,
    };
    cursorMs += segmentMs;
    if (cursorMs === endOfQuarterMs) {
      monthlyPeak = includeCompletedQuarter(monthlyPeak, quarter, timeZone);
      quarter = startCapacityQuarterTracking(cursorMs);
    }
  }

  return { quarter, monthlyPeak };
};

export const currentCapacityMonthKey = (nowMs: number, timeZone: string): string => monthKeyAt(nowMs, timeZone);
