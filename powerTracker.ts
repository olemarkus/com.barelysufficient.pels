import Homey from 'homey';
import CapacityGuard from './capacityGuard';

export const HOURLY_RETENTION_DAYS = 30; // Keep detailed hourly data for 30 days
export const DAILY_RETENTION_DAYS = 365; // Keep daily totals for 1 year

export interface PowerTrackerState {
  lastPowerW?: number;
  lastTimestamp?: number;
  buckets?: Record<string, number>; // Hourly data (ISO timestamp -> kWh)
  dailyTotals?: Record<string, number>; // Daily totals (YYYY-MM-DD -> kWh)
  hourlyAverages?: Record<string, { sum: number; count: number }>; // day-hour pattern (0-6_0-23 -> { sum, count })
}

export interface RecordPowerSampleParams {
  state: PowerTrackerState;
  currentPowerW: number;
  nowMs?: number;
  homey: Homey.App['homey'];
  capacityGuard?: CapacityGuard;
  rebuildPlanFromCache: () => void;
  saveState: (state: PowerTrackerState) => void;
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

export function aggregateAndPruneHistory(state: PowerTrackerState, homey: Homey.App['homey']): void {
  if (!state.buckets) return;

  const now = Date.now();
  const hourlyRetentionMs = HOURLY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const dailyRetentionMs = DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const hourlyThreshold = now - hourlyRetentionMs;
  const dailyThreshold = now - dailyRetentionMs;

  state.dailyTotals = state.dailyTotals || {};
  state.hourlyAverages = state.hourlyAverages || {};

  const bucketsToRemove: string[] = [];

  for (const [isoKey, kWh] of Object.entries(state.buckets)) {
    const timestamp = new Date(isoKey).getTime();
    if (Number.isNaN(timestamp)) continue;

    if (timestamp < hourlyThreshold) {
      const date = new Date(isoKey);
      const dayOfWeek = getDayOfWeekInHomeyTimezone(homey, date);
      const hourOfDay = getHourInHomeyTimezone(homey, date);
      const dateKey = formatDateInHomeyTimezone(homey, date);

      state.dailyTotals[dateKey] = (state.dailyTotals[dateKey] || 0) + kWh;

      const patternKey = `${dayOfWeek}_${hourOfDay}`;
      if (!state.hourlyAverages[patternKey]) {
        state.hourlyAverages[patternKey] = { sum: 0, count: 0 };
      }
      state.hourlyAverages[patternKey].sum += kWh;
      state.hourlyAverages[patternKey].count += 1;

      bucketsToRemove.push(isoKey);
    }
  }

  for (const key of bucketsToRemove) {
    delete state.buckets[key];
  }

  for (const dateKey of Object.keys(state.dailyTotals)) {
    const timestamp = new Date(dateKey).getTime();
    if (!Number.isNaN(timestamp) && timestamp < dailyThreshold) {
      delete state.dailyTotals[dateKey];
    }
  }
}

export function truncateToHour(timestamp: number): number {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

export async function recordPowerSample(params: RecordPowerSampleParams): Promise<void> {
  const {
    state,
    currentPowerW,
    nowMs = Date.now(),
    capacityGuard,
    rebuildPlanFromCache,
    saveState,
    homey: _homey,
  } = params;

  state.buckets = state.buckets || {};

  if (typeof state.lastTimestamp !== 'number' || typeof state.lastPowerW !== 'number') {
    state.lastTimestamp = nowMs;
    state.lastPowerW = currentPowerW;
    if (capacityGuard) capacityGuard.reportTotalPower(currentPowerW / 1000);
    saveState(state);
    rebuildPlanFromCache();
    return;
  }

  const previousTs = state.lastTimestamp;
  const previousPower = state.lastPowerW;
  let remainingMs = nowMs - previousTs;
  let currentTs = previousTs;

  while (remainingMs > 0) {
    const hourStart = truncateToHour(currentTs);
    const hourEnd = hourStart + 60 * 60 * 1000;
    const segmentMs = Math.min(remainingMs, hourEnd - currentTs);
    const energyKWh = (previousPower / 1000) * (segmentMs / 3600000);
    const bucketKey = new Date(hourStart).toISOString();
    state.buckets[bucketKey] = (state.buckets[bucketKey] || 0) + energyKWh;

    remainingMs -= segmentMs;
    currentTs += segmentMs;
  }

  state.lastTimestamp = nowMs;
  state.lastPowerW = currentPowerW;
  if (capacityGuard) capacityGuard.reportTotalPower(currentPowerW / 1000);
  rebuildPlanFromCache();
  saveState(state);
}
