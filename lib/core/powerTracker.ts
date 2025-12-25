import Homey from 'homey';
import CapacityGuard from './capacityGuard';
import { truncateToUtcHour, getHourBucketKey } from '../utils/dateUtils';

export const HOURLY_RETENTION_DAYS = 30; // Keep detailed hourly data for 30 days
export const DAILY_RETENTION_DAYS = 365; // Keep daily totals for 1 year

export type PowerTrackerState = {
  lastPowerW?: number;
  lastTimestamp?: number;
  buckets?: Record<string, number>; // Hourly data (ISO timestamp -> kWh)
  hourlyBudgets?: Record<string, number>; // Hourly budget snapshot (ISO timestamp -> kWh)
  dailyTotals?: Record<string, number>; // Daily totals (YYYY-MM-DD -> kWh)
  hourlyAverages?: Record<string, { sum: number; count: number }>; // day-hour pattern (0-6_0-23 -> { sum, count })
  unreliablePeriods?: Array<{ start: number; end: number }>; // Periods where data is missing/unreliable
};

export type RecordPowerSampleParams = {
  state: PowerTrackerState;
  currentPowerW: number;
  nowMs?: number;
  homey: Homey.App['homey'];
  capacityGuard?: CapacityGuard;
  hourBudgetKWh?: number;
  rebuildPlanFromCache: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
};

const MIN_VALID_TIMESTAMP_MS = 100000000000;
const MAX_SAMPLE_GAP_MS = 48 * 60 * 60 * 1000;

function shouldResetSampling(previousTs: number, nowMs: number): boolean {
  const elapsedMs = nowMs - previousTs;
  return previousTs < MIN_VALID_TIMESTAMP_MS || elapsedMs < 0 || elapsedMs > MAX_SAMPLE_GAP_MS;
}

function shouldResetSamplingState(state: PowerTrackerState, nowMs: number): boolean {
  const { lastTimestamp, lastPowerW } = state;
  if (typeof lastTimestamp !== 'number' || typeof lastPowerW !== 'number') return true;
  return shouldResetSampling(lastTimestamp, nowMs);
}

function buildNextPowerState(params: {
  state: PowerTrackerState;
  nextBuckets: Map<string, number>;
  nextBudgets: Map<string, number>;
  nowMs: number;
  currentPowerW: number;
  unreliablePeriods?: Array<{ start: number; end: number }>;
}): PowerTrackerState {
  const { state, nextBuckets, nextBudgets, nowMs, currentPowerW, unreliablePeriods } = params;
  return {
    ...state,
    buckets: Object.fromEntries(nextBuckets),
    hourlyBudgets: Object.fromEntries(nextBudgets),
    lastTimestamp: nowMs,
    lastPowerW: currentPowerW,
    unreliablePeriods: unreliablePeriods || state.unreliablePeriods,
  };
}

async function persistPowerSample(params: {
  nextState: PowerTrackerState;
  currentPowerW: number;
  capacityGuard?: CapacityGuard;
  saveState: (state: PowerTrackerState) => void;
  rebuildPlanFromCache: () => Promise<void>;
}): Promise<void> {
  const {
    nextState,
    currentPowerW,
    capacityGuard,
    saveState,
    rebuildPlanFromCache,
  } = params;
  if (capacityGuard) capacityGuard.reportTotalPower(currentPowerW / 1000);
  saveState(nextState);
  await rebuildPlanFromCache();
}

export function formatDateUtc(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getUtcHour(date: Date): number {
  return date.getUTCHours();
}

export function getUtcDayOfWeek(date: Date): number {
  return date.getUTCDay();
}

const processDayHourBuckets = (
  dayHourBuckets: Map<string, number[]>,
  averages: Map<string, { sum: number; count: number }>,
) => {
  for (const [dateKey, hours] of dayHourBuckets.entries()) {
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    const dayOfWeek = getUtcDayOfWeek(date);
    for (let hour = 0; hour < 24; hour += 1) {
      const patternKey = `${dayOfWeek}_${hour}`;
      const existingPattern = averages.get(patternKey) || { sum: 0, count: 0 };
      averages.set(patternKey, {
        sum: existingPattern.sum + hours[hour],
        count: existingPattern.count + 1,
      });
    }
  }
};

const pruneDailyTotals = (
  totals: Map<string, number>,
  threshold: number,
) => {
  const next = new Map<string, number>(totals);
  for (const dateKey of next.keys()) {
    const timestamp = new Date(dateKey).getTime();
    if (!Number.isNaN(timestamp) && timestamp < threshold) {
      next.delete(dateKey);
    }
  }
  return next;
};

export function aggregateAndPruneHistory(
  state: PowerTrackerState,
): PowerTrackerState {
  if (!state.buckets) return state;

  const now = Date.now();
  const hourlyRetentionMs = HOURLY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const hourlyThreshold = now - hourlyRetentionMs;

  const nextDailyTotals = new Map<string, number>(Object.entries(state.dailyTotals || {}));
  const nextHourlyAverages = new Map<string, { sum: number; count: number }>(
    Object.entries(state.hourlyAverages || {}) as Array<[string, { sum: number; count: number }]>,
  );
  const nextBuckets = new Map<string, number>();
  const nextBudgets = new Map<string, number>();
  const dayHourBuckets = new Map<string, number[]>();

  for (const [isoKey, kWh] of Object.entries(state.buckets)) {
    const timestamp = new Date(isoKey).getTime();
    if (Number.isNaN(timestamp)) continue;

    if (timestamp < hourlyThreshold) {
      const date = new Date(isoKey);
      const dateKey = formatDateUtc(date);
      const hourOfDay = getUtcHour(date);
      const hours = dayHourBuckets.get(dateKey) || Array.from({ length: 24 }, () => 0);
      const nextHours = hours.map((hourValue, index) => (index === hourOfDay ? hourValue + kWh : hourValue));
      dayHourBuckets.set(dateKey, nextHours);
      nextDailyTotals.set(dateKey, (nextDailyTotals.get(dateKey) || 0) + kWh);
    } else {
      nextBuckets.set(isoKey, kWh);
      const budget = (state.hourlyBudgets || {})[isoKey];
      if (budget !== undefined) nextBudgets.set(isoKey, budget);
    }
  }

  processDayHourBuckets(dayHourBuckets, nextHourlyAverages);

  const dailyRetentionMs = DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const prunedDaily = pruneDailyTotals(nextDailyTotals, now - dailyRetentionMs);

  return {
    ...state,
    buckets: Object.fromEntries(nextBuckets),
    hourlyBudgets: Object.fromEntries(nextBudgets),
    dailyTotals: Object.fromEntries(prunedDaily),
    hourlyAverages: Object.fromEntries(nextHourlyAverages),
    unreliablePeriods: (state.unreliablePeriods || []).filter((p) => p.end >= hourlyThreshold),
  };
}

export function truncateToHourInHomeyTimezone(homey: Homey.App['homey'], timestamp: number): number {
  const date = new Date(timestamp);
  const timezone = homey.clock.getTimezone();
  try {
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const getPart = (type: Intl.DateTimeFormatPartTypes) => {
      const part = parts.find((entry) => entry.type === type);
      return part ? part.value : '';
    };
    const year = Number(getPart('year'));
    const month = Number(getPart('month'));
    const day = Number(getPart('day'));
    const hour = Number(getPart('hour'));
    const minute = Number(getPart('minute'));
    const second = Number(getPart('second'));
    if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value))) {
      throw new Error('Invalid date parts');
    }
    const utcCandidate = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMs = utcCandidate - date.getTime();
    return Date.UTC(year, month - 1, day, hour, 0, 0, 0) - offsetMs;
  } catch {
    const fallback = new Date(timestamp);
    fallback.setMinutes(0, 0, 0);
    return fallback.getTime();
  }
}


const calculateEnergyAcrossBoundaries = (params: {
  startTs: number;
  endTs: number;
  powerW: number;
  buckets: Map<string, number>;
  budgets: Map<string, number>;
  budgetKWh: number | null;
}) => {
  const { startTs, endTs, powerW, buckets, budgets, budgetKWh } = params;
  let currentTs = startTs;
  let remainingMs = endTs - startTs;

  while (remainingMs > 0) {
    const hourStart = truncateToUtcHour(currentTs);
    const hourEnd = hourStart + 60 * 60 * 1000;
    const segmentMs = Math.min(remainingMs, hourEnd - currentTs);
    const energyKWh = (powerW / 1000) * (segmentMs / 3600000);
    const bucketKey = new Date(hourStart).toISOString();

    buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + energyKWh);
    if (budgetKWh !== null) {
      budgets.set(bucketKey, budgetKWh);
    }

    remainingMs -= segmentMs;
    currentTs += segmentMs;
  }
};

export async function recordPowerSample(params: RecordPowerSampleParams): Promise<void> {
  const {
    state, currentPowerW, nowMs = Date.now(), capacityGuard,
    hourBudgetKWh, rebuildPlanFromCache, saveState,
  } = params;

  const nextBuckets = new Map<string, number>(Object.entries(state.buckets || {}));
  const nextBudgets = new Map<string, number>(Object.entries(state.hourlyBudgets || {}));
  const budgetKWh = typeof hourBudgetKWh === 'number' ? hourBudgetKWh : null;
  if (budgetKWh !== null) {
    nextBudgets.set(getHourBucketKey(nowMs), budgetKWh);
  }

  if (shouldResetSamplingState(state, nowMs)) {
    const nextState = buildNextPowerState({
      state, nextBuckets, nextBudgets, nowMs, currentPowerW,
    });
    await persistPowerSample({
      nextState, currentPowerW, capacityGuard, saveState, rebuildPlanFromCache,
    });
    return;
  }

  const previousTs = state.lastTimestamp as number;
  const previousPower = state.lastPowerW as number;
  const gapDuration = nowMs - previousTs;
  const crossesHour = truncateToUtcHour(previousTs) !== truncateToUtcHour(nowMs);
  const oneMinGap = gapDuration > 60 * 1000;

  const unreliablePeriods = (gapDuration > 60 * 60 * 1000 || (oneMinGap && crossesHour))
    ? [...(state.unreliablePeriods || []), { start: previousTs, end: nowMs }]
    : state.unreliablePeriods;

  calculateEnergyAcrossBoundaries({
    startTs: previousTs,
    endTs: nowMs,
    powerW: previousPower,
    buckets: nextBuckets,
    budgets: nextBudgets,
    budgetKWh,
  });

  const nextState = buildNextPowerState({
    state, nextBuckets, nextBudgets, nowMs, currentPowerW, unreliablePeriods,
  });
  await persistPowerSample({
    nextState, currentPowerW, capacityGuard, saveState, rebuildPlanFromCache,
  });
}
