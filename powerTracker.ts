import Homey from 'homey';
import CapacityGuard from './capacityGuard';

export const HOURLY_RETENTION_DAYS = 30; // Keep detailed hourly data for 30 days
export const DAILY_RETENTION_DAYS = 365; // Keep daily totals for 1 year

export type PowerTrackerState = {
  lastPowerW?: number;
  lastTimestamp?: number;
  buckets?: Record<string, number>; // Hourly data (ISO timestamp -> kWh)
  dailyTotals?: Record<string, number>; // Daily totals (YYYY-MM-DD -> kWh)
  hourlyAverages?: Record<string, { sum: number; count: number }>; // day-hour pattern (0-6_0-23 -> { sum, count })
};

export type RecordPowerSampleParams = {
  state: PowerTrackerState;
  currentPowerW: number;
  nowMs?: number;
  homey: Homey.App['homey'];
  capacityGuard?: CapacityGuard;
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
  nowMs: number;
  currentPowerW: number;
}): PowerTrackerState {
  const { state, nextBuckets, nowMs, currentPowerW } = params;
  return {
    ...state,
    buckets: Object.fromEntries(nextBuckets),
    lastTimestamp: nowMs,
    lastPowerW: currentPowerW,
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

export function formatDateInHomeyTimezone(homey: Homey.App['homey'], date: Date): string {
  const timezone = homey.clock.getTimezone();
  try {
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(date);
  } catch {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

export function getHourInHomeyTimezone(homey: Homey.App['homey'], date: Date): number {
  const timezone = homey.clock.getTimezone();
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(date), 10);
  } catch {
    return date.getHours();
  }
}

export function getDayOfWeekInHomeyTimezone(homey: Homey.App['homey'], date: Date): number {
  const timezone = homey.clock.getTimezone();
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    });
    const weekday = formatter.format(date);
    const days: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return days[weekday] ?? date.getDay();
  } catch {
    return date.getDay();
  }
}

export function aggregateAndPruneHistory(
  state: PowerTrackerState,
  homey: Homey.App['homey'],
): PowerTrackerState {
  if (!state.buckets) return state;

  const now = Date.now();
  const hourlyRetentionMs = HOURLY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const dailyRetentionMs = DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const hourlyThreshold = now - hourlyRetentionMs;
  const dailyThreshold = now - dailyRetentionMs;

  const nextDailyTotals = new Map<string, number>(Object.entries(state.dailyTotals || {}));
  const nextHourlyAverages = new Map<string, { sum: number; count: number }>(
    Object.entries(state.hourlyAverages || {}) as Array<[string, { sum: number; count: number }]>,
  );
  const nextBuckets = new Map<string, number>();

  for (const [isoKey, kWh] of Object.entries(state.buckets)) {
    const timestamp = new Date(isoKey).getTime();
    if (Number.isNaN(timestamp)) continue;

    if (timestamp < hourlyThreshold) {
      const date = new Date(isoKey);
      const dayOfWeek = getDayOfWeekInHomeyTimezone(homey, date);
      const hourOfDay = getHourInHomeyTimezone(homey, date);
      const dateKey = formatDateInHomeyTimezone(homey, date);

      nextDailyTotals.set(dateKey, (nextDailyTotals.get(dateKey) || 0) + kWh);

      const patternKey = `${dayOfWeek}_${hourOfDay}`;
      const existingPattern = nextHourlyAverages.get(patternKey) || { sum: 0, count: 0 };
      nextHourlyAverages.set(patternKey, {
        sum: existingPattern.sum + kWh,
        count: existingPattern.count + 1,
      });
      continue;
    }
    nextBuckets.set(isoKey, kWh);
  }

  for (const dateKey of nextDailyTotals.keys()) {
    const timestamp = new Date(dateKey).getTime();
    if (!Number.isNaN(timestamp) && timestamp < dailyThreshold) {
      nextDailyTotals.delete(dateKey);
    }
  }

  return {
    ...state,
    buckets: Object.fromEntries(nextBuckets),
    dailyTotals: Object.fromEntries(nextDailyTotals),
    hourlyAverages: Object.fromEntries(nextHourlyAverages),
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

export async function recordPowerSample(params: RecordPowerSampleParams): Promise<void> {
  const {
    state,
    currentPowerW,
    nowMs = Date.now(),
    capacityGuard,
    rebuildPlanFromCache,
    saveState,
    homey,
  } = params;

  const nextBuckets = new Map<string, number>(Object.entries(state.buckets || {}));

  if (shouldResetSamplingState(state, nowMs)) {
    const nextState = buildNextPowerState({
      state,
      nextBuckets,
      nowMs,
      currentPowerW,
    });
    await persistPowerSample({
      nextState,
      currentPowerW,
      capacityGuard,
      saveState,
      rebuildPlanFromCache,
    });
    return;
  }

  const previousTs = state.lastTimestamp as number;
  const previousPower = state.lastPowerW as number;
  let remainingMs = nowMs - previousTs;
  let currentTs = previousTs;

  while (remainingMs > 0) {
    const hourStart = truncateToHourInHomeyTimezone(homey, currentTs);
    const hourEnd = hourStart + 60 * 60 * 1000;
    const segmentMs = Math.min(remainingMs, hourEnd - currentTs);
    const energyKWh = (previousPower / 1000) * (segmentMs / 3600000);
    const bucketKey = new Date(hourStart).toISOString();
    const nextValue = (nextBuckets.get(bucketKey) || 0) + energyKWh;
    nextBuckets.set(bucketKey, nextValue);

    remainingMs -= segmentMs;
    currentTs += segmentMs;
  }

  const nextState = buildNextPowerState({
    state,
    nextBuckets,
    nowMs,
    currentPowerW,
  });
  await persistPowerSample({
    nextState,
    currentPowerW,
    capacityGuard,
    saveState,
    rebuildPlanFromCache,
  });
}
