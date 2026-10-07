// Cache for the backtested daily-budget confidence (`dailyBudgetConfidence.ts`).
// The backtest is too heavy for every power sample, so the manager resolves it
// through here: a cheap closed-days mark decides when the history must be
// fingerprinted again, and the fingerprint decides when the backtest reruns.
import type { PowerTrackerState } from '../power/tracker';
import { getPreviousLocalDayStartUtcMs } from '../../packages/shared-domain/src/utils/dateUtils';
import { computeBacktestedConfidence, LOOKBACK_DAYS, type ConfidenceResult } from './dailyBudgetConfidence';
import type { DayContext } from './dailyBudgetState';

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

function getConfidenceWindowStartUtcMs(context: DayContext): number {
  let windowStartUtcMs = context.dayStartUtcMs;
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    windowStartUtcMs = getPreviousLocalDayStartUtcMs(windowStartUtcMs, context.timeZone);
  }
  return windowStartUtcMs;
}

function appendHashString(hash: number, value: string): number {
  let next = hash >>> 0;
  for (let i = 0; i < value.length; i++) {
    next ^= value.charCodeAt(i);
    next = Math.imul(next, FNV_PRIME) >>> 0;
  }
  return next;
}

function appendHashNumber(hash: number, value: number): number {
  return appendHashString(hash, Number.isFinite(value) ? value.toString() : 'NaN');
}

function appendRecordFingerprint(
  hash: number,
  label: string,
  record: Record<string, number> | undefined,
  windowStartUtcMs: number,
  dayStartUtcMs: number,
): number {
  let next = appendHashString(hash, label);
  if (!record) return next;
  const relevantKeys = Object.keys(record)
    .filter((key) => {
      const ts = Date.parse(key);
      return Number.isFinite(ts) && ts >= windowStartUtcMs && ts < dayStartUtcMs;
    })
    .sort();
  for (const key of relevantKeys) {
    // `relevantKeys` comes from `Object.keys(record)`, so every key has a value.
    const value = record[key];
    next = appendHashString(next, key);
    if (value !== undefined) next = appendHashNumber(next, value);
  }
  return next;
}

function appendUnreliablePeriodsFingerprint(
  hash: number,
  unreliablePeriods: PowerTrackerState['unreliablePeriods'],
  windowStartUtcMs: number,
  dayStartUtcMs: number,
): number {
  let next = appendHashString(hash, 'u');
  const relevantPeriods = (unreliablePeriods ?? [])
    .filter((period) => period.end > windowStartUtcMs && period.start < dayStartUtcMs)
    .slice()
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));
  for (const period of relevantPeriods) {
    next = appendHashNumber(next, period.start);
    next = appendHashNumber(next, period.end);
  }
  return next;
}

function buildConfidenceInputKey(powerTracker: PowerTrackerState, context: DayContext): string {
  const { timeZone, dateKey, dayStartUtcMs } = context;
  const windowStartUtcMs = getConfidenceWindowStartUtcMs(context);
  let hash = FNV_OFFSET_BASIS;
  hash = appendHashString(hash, timeZone);
  hash = appendHashString(hash, dateKey);
  hash = appendRecordFingerprint(hash, 'b', powerTracker.buckets, windowStartUtcMs, dayStartUtcMs);
  hash = appendRecordFingerprint(hash, 'c', powerTracker.controlledBuckets, windowStartUtcMs, dayStartUtcMs);
  hash = appendRecordFingerprint(hash, 'p', powerTracker.dailyBudgetCaps, windowStartUtcMs, dayStartUtcMs);
  hash = appendUnreliablePeriodsFingerprint(hash, powerTracker.unreliablePeriods, windowStartUtcMs, dayStartUtcMs);
  return hash.toString(16);
}

function withProfileBlendConfidence(
  result: ConfidenceResult,
  profileBlendConfidence: number,
): ConfidenceResult {
  if (result.debug.profileBlendConfidence === profileBlendConfidence) return result;
  return {
    ...result,
    debug: {
      ...result.debug,
      profileBlendConfidence,
    },
  };
}

/**
 * A cheap mark of the history the backtest window (the complete local days
 * before today) can see. A past day is written after the fact in two ways: a
 * sample that arrives after a gap books the gap's energy into the hours it
 * spans, and the tracker appends an unreliable period for a gap or a frozen
 * reading once it ends. The first can only reach a past day while the tracker's
 * last sample is still before today's start; the second always appends a period.
 * So the mark changes with the date, the zone, the first sample of the day and
 * any new period, and holds through every routine sample in between. The
 * service re-seeds the adjacent days on the same mark.
 */
export function describeClosedDaysHistory(powerTracker: PowerTrackerState, context: DayContext): string {
  const { dateKey, timeZone, dayStartUtcMs } = context;
  const { lastTimestamp, unreliablePeriods = [] } = powerTracker;
  const dayClosed = typeof lastTimestamp === 'number' && lastTimestamp >= dayStartUtcMs;
  const lastPeriod = unreliablePeriods[unreliablePeriods.length - 1];
  const lastPeriodMark = lastPeriod ? `${lastPeriod.start}-${lastPeriod.end}` : '';
  return `${dateKey}|${timeZone}|${dayClosed ? 'closed' : 'open'}|${unreliablePeriods.length}|${lastPeriodMark}`;
}

// The backtest result is a pure function of the date, the zone and the window's
// history, so routine updates reuse the entry while the closed-days mark holds,
// without fingerprinting that history. `refresh` re-checks the fingerprint for a
// command (a forced recompute, a model or history change) the mark cannot see.
type ConfidenceCacheEntry = {
  historyMark: string;
  inputKey: string;
  result: ConfidenceResult;
  bootstrapComplete: boolean;
};

export type ConfidenceCache = {
  entry: ConfidenceCacheEntry | null;
};

export function createConfidenceCache(): ConfidenceCache {
  return { entry: null };
}

/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
export function resolveConfidence(
  cache: ConfidenceCache,
  context: DayContext,
  powerTracker: PowerTrackerState,
  profileBlendConfidence: number,
  refresh: boolean,
  includeBootstrapDebug: boolean,
): ConfidenceResult {
  const historyMark = describeClosedDaysHistory(powerTracker, context);
  const { entry } = cache;
  if (entry && !refresh && entry.historyMark === historyMark) {
    return withProfileBlendConfidence(entry.result, profileBlendConfidence);
  }
  const inputKey = buildConfidenceInputKey(powerTracker, context);
  if (entry && entry.inputKey === inputKey && (includeBootstrapDebug === false || entry.bootstrapComplete)) {
    Object.assign(cache, { entry: { ...entry, historyMark } });
    return withProfileBlendConfidence(entry.result, profileBlendConfidence);
  }
  const result = computeBacktestedConfidence({
    nowMs: context.nowMs,
    timeZone: context.timeZone,
    powerTracker,
    profileBlendConfidence,
    includeBootstrapDebug,
  });
  Object.assign(cache, {
    entry: {
      historyMark,
      inputKey,
      result,
      bootstrapComplete: includeBootstrapDebug,
    },
  });
  return result;
}
/* eslint-enable functional/immutable-data */
