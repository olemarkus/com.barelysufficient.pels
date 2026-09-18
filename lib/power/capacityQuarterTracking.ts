import { getZonedParts } from '../utils/dateUtils';
import {
  MAX_POWER_SAMPLE_GAP_MS,
  type CapacityMonthlyPeak,
  type CapacityQuarter,
} from './trackerTypes';
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

/**
 * Project completed quarters implied by a held sparse sample without changing
 * tracker state. The active partial quarter and, when the gap is longer, one
 * representative full quarter are sufficient: every intervening full quarter
 * has the same held power and therefore the same average.
 */
export const projectCapacityMonthlyPeak = (
  quarter: CapacityQuarter | undefined,
  monthlyPeak: CapacityMonthlyPeak | undefined,
  lastTimestamp: number | undefined,
  nowMs: number,
  powerW: number | undefined,
  timeZone: string,
): CapacityMonthlyPeak | undefined => {
  if (
    quarter === undefined
    || lastTimestamp === undefined
    || powerW === undefined
    || nowMs <= lastTimestamp
    || nowMs - lastTimestamp > MAX_POWER_SAMPLE_GAP_MS
  ) return monthlyPeak;

  const activeQuarterEndMs = quarter.startMs + CAPACITY_QUARTER_MS;
  let projectedPeak = monthlyPeak;
  if (activeQuarterEndMs <= nowMs && lastTimestamp < activeQuarterEndMs) {
    projectedPeak = accrueCapacityQuarter(
      quarter,
      projectedPeak,
      lastTimestamp,
      activeQuarterEndMs,
      powerW,
      timeZone,
    ).monthlyPeak;
  }

  const latestCompletedQuarterStartMs = quarterStart(nowMs) - CAPACITY_QUARTER_MS;
  if (activeQuarterEndMs <= latestCompletedQuarterStartMs) {
    projectedPeak = includeCompletedQuarter(projectedPeak, {
      startMs: latestCompletedQuarterStartMs,
      energyKWh: Math.max(0, powerW) / 4_000,
      trackedMs: CAPACITY_QUARTER_MS,
    }, timeZone);
  }
  return projectedPeak;
};

export const currentCapacityMonthKey = (nowMs: number, timeZone: string): string => monthKeyAt(nowMs, timeZone);
