import type CapacityGuard from './capacityGuard';
import type { PowerTrackerState, RecordPowerSampleParams } from './trackerTypes';
import { truncateToUtcHour, getHourBucketKey, getZonedParts } from '../utils/dateUtils';
import { addPerfDuration } from '../utils/perfCounters';
import {
  accumulateDevicePowerIfAvailable,
  calculateEnergyAcrossBoundaries,
  normalizeDevicePowerWById,
  pruneHourlyBucketsOnly,
  serializeDeviceBuckets,
} from './trackerEnergy';
export const HOURLY_RETENTION_DAYS = 30;
export const DAILY_RETENTION_DAYS = 365;
export type { PowerTrackerState, RecordPowerSampleParams } from './trackerTypes';
const MIN_VALID_TIMESTAMP_MS = 100000000000, MAX_SAMPLE_GAP_MS = 48 * 60 * 60 * 1000;
const ZERO_HOURS = Array.from({ length: 24 }, () => 0);

type ControlledSample = {
  controlledPowerW?: number;
  uncontrolledPowerW?: number;
};
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
  nextHourlySampleCounts: Map<string, number>;
  nextBudgets: Map<string, number>;
  nextControlledBuckets?: Map<string, number>;
  nextUncontrolledBuckets?: Map<string, number>;
  nextExemptBuckets?: Map<string, number>;
  nextDeviceBuckets: Map<string, Map<string, number>>;
  nowMs: number;
  currentPowerW: number;
  currentControlledPowerW?: number;
  currentUncontrolledPowerW?: number;
  currentExemptPowerW?: number;
  currentDevicePowerWById?: Record<string, number>;
  unreliablePeriods?: Array<{ start: number; end: number }>;
}): PowerTrackerState {
  const {
    state,
    nextBuckets,
    nextHourlySampleCounts,
    nextBudgets,
    nextControlledBuckets,
    nextUncontrolledBuckets,
    nextExemptBuckets,
    nextDeviceBuckets,
    nowMs,
    currentPowerW,
    currentControlledPowerW,
    currentUncontrolledPowerW,
    currentExemptPowerW,
    currentDevicePowerWById,
    unreliablePeriods,
  } = params;
  return {
    ...state,
    buckets: Object.fromEntries(nextBuckets),
    hourlySampleCounts: Object.fromEntries(nextHourlySampleCounts),
    hourlyBudgets: Object.fromEntries(nextBudgets),
    controlledBuckets: nextControlledBuckets ? Object.fromEntries(nextControlledBuckets) : state.controlledBuckets,
    uncontrolledBuckets: nextUncontrolledBuckets
      ? Object.fromEntries(nextUncontrolledBuckets)
      : state.uncontrolledBuckets,
    exemptBuckets: nextExemptBuckets ? Object.fromEntries(nextExemptBuckets) : state.exemptBuckets,
    deviceBuckets: serializeDeviceBuckets(nextDeviceBuckets),
    lastDevicePowerWById: currentDevicePowerWById,
    lastTimestamp: nowMs,
    lastPowerW: currentPowerW,
    lastControlledPowerW: currentControlledPowerW,
    lastUncontrolledPowerW: currentUncontrolledPowerW,
    lastExemptPowerW: currentExemptPowerW,
    unreliablePeriods: unreliablePeriods || state.unreliablePeriods,
  };
}

async function persistPowerSample(params: {
  nextState: PowerTrackerState;
  currentPowerW: number;
  capacityGuard?: CapacityGuard;
  saveState: (state: PowerTrackerState) => void;
  rebuildPlanFromCache: (reason?: string) => Promise<void>;
}): Promise<void> {
  const {
    nextState,
    currentPowerW,
    capacityGuard,
    saveState,
    rebuildPlanFromCache,
  } = params;
  if (capacityGuard) {
    const capacityGuardStart = Date.now();
    try {
      capacityGuard.reportTotalPower(currentPowerW / 1000);
    } finally {
      addPerfDuration('power_sample_capacity_guard_ms', Date.now() - capacityGuardStart);
    }
  }
  saveState(nextState);
  const rebuildWaitStart = Date.now();
  try {
    await rebuildPlanFromCache('power_tracker_persist');
  } finally {
    addPerfDuration('power_sample_rebuild_wait_ms', Date.now() - rebuildWaitStart);
  }
}

function resolveControlledSample(params: {
  currentPowerW: number;
  controlledPowerW?: number;
}): ControlledSample {
  const { currentPowerW, controlledPowerW } = params;
  const boundedControlled = resolveBoundedTrackedPowerW(currentPowerW, controlledPowerW);
  if (typeof boundedControlled !== 'number') {
    return {};
  }
  return {
    controlledPowerW: boundedControlled,
    uncontrolledPowerW: Math.max(0, currentPowerW - boundedControlled),
  };
}

function resolveBoundedTrackedPowerW(currentPowerW: number, trackedPowerW?: number): number | undefined {
  if (typeof trackedPowerW !== 'number' || !Number.isFinite(trackedPowerW)) {
    return undefined;
  }
  return Math.max(0, Math.min(trackedPowerW, currentPowerW));
}

function buildTrackedBucketMaps(state: PowerTrackerState): {
  nextBuckets: Map<string, number>;
  nextHourlySampleCounts: Map<string, number>;
  nextBudgets: Map<string, number>;
  nextControlledBuckets: Map<string, number>;
  nextUncontrolledBuckets: Map<string, number>;
  nextExemptBuckets: Map<string, number>;
  nextDeviceBuckets: Map<string, Map<string, number>>;
} {
  return {
    nextBuckets: new Map<string, number>(Object.entries(state.buckets || {})),
    nextHourlySampleCounts: new Map<string, number>(Object.entries(state.hourlySampleCounts || {})),
    nextBudgets: new Map<string, number>(Object.entries(state.hourlyBudgets || {})),
    nextControlledBuckets: new Map<string, number>(Object.entries(state.controlledBuckets || {})),
    nextUncontrolledBuckets: new Map<string, number>(Object.entries(state.uncontrolledBuckets || {})),
    nextExemptBuckets: new Map<string, number>(Object.entries(state.exemptBuckets || {})),
    nextDeviceBuckets: new Map<string, Map<string, number>>(
      Object.entries(state.deviceBuckets || {}).map(([deviceId, buckets]) => [
        deviceId,
        new Map<string, number>(Object.entries(buckets)),
      ]),
    ),
  };
}

function applyCurrentHourSample(params: {
  nextHourlySampleCounts: Map<string, number>;
  nextBudgets: Map<string, number>;
  nowMs: number;
  hourBudgetKWh?: number;
}): number | null {
  const {
    nextHourlySampleCounts,
    nextBudgets,
    nowMs,
    hourBudgetKWh,
  } = params;
  const budgetKWh = typeof hourBudgetKWh === 'number' ? hourBudgetKWh : null;
  const currentHourKey = getHourBucketKey(nowMs);
  if (budgetKWh !== null) {
    nextBudgets.set(currentHourKey, budgetKWh);
  }
  nextHourlySampleCounts.set(currentHourKey, (nextHourlySampleCounts.get(currentHourKey) || 0) + 1);
  return budgetKWh;
}

function resolveUnreliablePeriods(params: {
  state: PowerTrackerState;
  previousTs: number;
  nowMs: number;
}): PowerTrackerState['unreliablePeriods'] {
  const { state, previousTs, nowMs } = params;
  const gapDuration = nowMs - previousTs;
  const crossesHour = truncateToUtcHour(previousTs) !== truncateToUtcHour(nowMs);
  const oneMinGap = gapDuration > 60 * 1000;
  return (gapDuration > 60 * 60 * 1000 || (oneMinGap && crossesHour))
    ? [...(state.unreliablePeriods || []), { start: previousTs, end: nowMs }]
    : state.unreliablePeriods;
}

function accumulatePowerIfAvailable(params: {
  previousPowerW?: number;
  nextPowerW?: number;
  startTs: number;
  endTs: number;
  buckets: Map<string, number>;
}): void {
  const { previousPowerW, nextPowerW, startTs, endTs, buckets } = params;
  if (typeof previousPowerW !== 'number' || typeof nextPowerW !== 'number') return;
  calculateEnergyAcrossBoundaries({
    startTs,
    endTs,
    powerW: previousPowerW,
    buckets,
    budgets: new Map(),
    budgetKWh: null,
  });
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
    // dateKey is YYYY-MM-DD (UTC date or Homey-local date, depending on caller).
    // Parsing midnight-UTC of the same YYYY-MM-DD gives the right calendar weekday
    // either way — weekday is a property of the date label itself, not its instant.
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
function resolveDayHourKey(date: Date, timeZone?: string): { dateKey: string; hourOfDay: number } {
  if (timeZone) {
    // Call getZonedParts once — each call allocates an Intl.DateTimeFormat; avoid the
    // double allocation that would result from calling getDateKeyInTimeZone + getZonedParts
    // separately (getDateKeyInTimeZone already calls getZonedParts internally).
    const { year, month, day, hour } = getZonedParts(date, timeZone);
    const yyyy = year.toString().padStart(4, '0');
    const mm = month.toString().padStart(2, '0');
    const dd = day.toString().padStart(2, '0');
    const dateKey = `${yyyy}-${mm}-${dd}`;
    return { dateKey, hourOfDay: hour };
  }
  return { dateKey: formatDateUtc(date), hourOfDay: getUtcHour(date) };
}

export function aggregateAndPruneHistory(
  state: PowerTrackerState,
  options?: { timeZone?: string },
): PowerTrackerState {
  // When `timeZone` is provided, dailyTotals/hourlyAverages buckets are keyed by the
  // Homey-local calendar date and hour-of-day. Without it we fall back to UTC keys
  // (the historical behaviour, preserved so existing callers and persisted state
  // continue to work without a forced migration).
  const timeZone = options?.timeZone;
  const now = Date.now();
  const hourlyRetentionMs = HOURLY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const hourlyThreshold = now - hourlyRetentionMs;
  const dailyRetentionMs = DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const aggregateBucketsForRetention = (params: {
    buckets?: Record<string, number>;
    existingDailyTotals?: Record<string, number>;
    existingHourlyAverages?: Record<string, { sum: number; count: number }>;
  }) => {
    const { buckets, existingDailyTotals, existingHourlyAverages } = params;
    const nextDailyTotals = new Map<string, number>(Object.entries(existingDailyTotals || {}));
    const nextHourlyAverages = new Map<string, { sum: number; count: number }>(
      Object.entries(existingHourlyAverages || {}) as Array<[string, { sum: number; count: number }]>,
    );
    const nextBuckets = new Map<string, number>();
    const dayHourBuckets = new Map<string, number[]>();

    if (buckets) {
      for (const [isoKey, kWh] of Object.entries(buckets)) {
        const timestamp = new Date(isoKey).getTime();
        if (Number.isNaN(timestamp)) continue;

        if (timestamp < hourlyThreshold) {
          const { dateKey, hourOfDay } = resolveDayHourKey(new Date(isoKey), timeZone);
          const hours = dayHourBuckets.get(dateKey) ?? ZERO_HOURS.slice();
          hours[hourOfDay] = (hours[hourOfDay] ?? 0) + kWh;
          dayHourBuckets.set(dateKey, hours);
          nextDailyTotals.set(dateKey, (nextDailyTotals.get(dateKey) || 0) + kWh);
        } else {
          nextBuckets.set(isoKey, kWh);
        }
      }
    }

    processDayHourBuckets(dayHourBuckets, nextHourlyAverages);
    const prunedDaily = pruneDailyTotals(nextDailyTotals, now - dailyRetentionMs);
    return {
      nextBuckets,
      nextDailyTotals: prunedDaily,
      nextHourlyAverages,
    };
  };

  const aggregateForType = (
    buckets?: Record<string, number>,
    dailyTotals?: Record<string, number>,
    hourlyAverages?: Record<string, { sum: number; count: number }>,
  ) => {
    const { nextBuckets, nextDailyTotals, nextHourlyAverages } = aggregateBucketsForRetention({
      buckets,
      existingDailyTotals: dailyTotals,
      existingHourlyAverages: hourlyAverages,
    });
    return {
      nextBuckets,
      buckets: buckets ? Object.fromEntries(nextBuckets) : buckets,
      dailyTotals: Object.fromEntries(nextDailyTotals),
      hourlyAverages: Object.fromEntries(nextHourlyAverages),
    };
  };
  const totalAggregate = aggregateForType(state.buckets, state.dailyTotals, state.hourlyAverages);
  const nextHourlySampleCounts = new Map<string, number>();
  for (const isoKey of totalAggregate.nextBuckets.keys()) {
    const sampleCount = state.hourlySampleCounts?.[isoKey];
    if (typeof sampleCount === 'number' && Number.isFinite(sampleCount) && sampleCount > 0) {
      nextHourlySampleCounts.set(isoKey, sampleCount);
    }
  }
  const controlledAggregate = aggregateForType(
    state.controlledBuckets,
    state.controlledDailyTotals,
    state.controlledHourlyAverages,
  );
  const uncontrolledAggregate = aggregateForType(
    state.uncontrolledBuckets,
    state.uncontrolledDailyTotals,
    state.uncontrolledHourlyAverages,
  );
  const exemptAggregate = aggregateForType(
    state.exemptBuckets,
    state.exemptDailyTotals,
    state.exemptHourlyAverages,
  );
  const deviceBucketEntries = (
    Object.entries(state.deviceBuckets || {}).flatMap(([deviceId, buckets]) => {
      const retained = Object.fromEntries(pruneHourlyBucketsOnly({ buckets, hourlyThreshold }) || []);
      return Object.keys(retained).length > 0 ? [[deviceId, retained] as const] : [];
    })
  );
  const deviceBuckets = deviceBucketEntries.length > 0 ? Object.fromEntries(deviceBucketEntries) : undefined;

  const nextBudgets = new Map<string, number>();
  const nextDailyCaps = new Map<string, number>();
  for (const isoKey of totalAggregate.nextBuckets.keys()) {
    const budget = (state.hourlyBudgets || {})[isoKey];
    if (budget !== undefined) nextBudgets.set(isoKey, budget);
    const dailyCap = (state.dailyBudgetCaps || {})[isoKey];
    if (dailyCap !== undefined) nextDailyCaps.set(isoKey, dailyCap);
  }

  return {
    ...state,
    buckets: totalAggregate.buckets,
    hourlySampleCounts: Object.fromEntries(nextHourlySampleCounts),
    hourlyBudgets: Object.fromEntries(nextBudgets),
    dailyBudgetCaps: Object.fromEntries(nextDailyCaps),
    dailyTotals: totalAggregate.dailyTotals,
    hourlyAverages: totalAggregate.hourlyAverages,
    controlledBuckets: controlledAggregate.buckets,
    uncontrolledBuckets: uncontrolledAggregate.buckets,
    exemptBuckets: exemptAggregate.buckets,
    controlledDailyTotals: controlledAggregate.dailyTotals,
    uncontrolledDailyTotals: uncontrolledAggregate.dailyTotals,
    exemptDailyTotals: exemptAggregate.dailyTotals,
    controlledHourlyAverages: controlledAggregate.hourlyAverages,
    uncontrolledHourlyAverages: uncontrolledAggregate.hourlyAverages,
    exemptHourlyAverages: exemptAggregate.hourlyAverages,
    deviceBuckets,
    unreliablePeriods: (state.unreliablePeriods || []).filter((p) => p.end >= hourlyThreshold),
  };
}

export async function recordPowerSample(params: RecordPowerSampleParams): Promise<void> {
  const bookkeepingStart = Date.now();
  const {
    state, currentPowerW, controlledPowerW, exemptPowerW, currentDevicePowerWById, nowMs = Date.now(), capacityGuard,
    hourBudgetKWh, rebuildPlanFromCache, saveState,
  } = params;

  const {
    nextBuckets,
    nextHourlySampleCounts,
    nextBudgets,
    nextControlledBuckets,
    nextUncontrolledBuckets,
    nextExemptBuckets,
    nextDeviceBuckets,
  } = buildTrackedBucketMaps(state);
  const budgetKWh = applyCurrentHourSample({
    nextHourlySampleCounts,
    nextBudgets,
    nowMs,
    hourBudgetKWh,
  });

  const {
    controlledPowerW: boundedControlledPowerW,
    uncontrolledPowerW: boundedUncontrolledPowerW,
  } = resolveControlledSample({
    currentPowerW,
    controlledPowerW,
  });
  const boundedExemptPowerW = resolveBoundedTrackedPowerW(currentPowerW, exemptPowerW);
  const normalizedDevicePowerWById = normalizeDevicePowerWById(currentDevicePowerWById);

  if (shouldResetSamplingState(state, nowMs)) {
    const nextState = buildNextPowerState({
      state,
      nextBuckets,
      nextHourlySampleCounts,
      nextBudgets,
      nextControlledBuckets,
      nextUncontrolledBuckets,
      nextExemptBuckets,
      nextDeviceBuckets,
      nowMs,
      currentPowerW,
      currentControlledPowerW: boundedControlledPowerW,
      currentUncontrolledPowerW: boundedUncontrolledPowerW,
      currentExemptPowerW: boundedExemptPowerW,
      currentDevicePowerWById: normalizedDevicePowerWById,
    });
    addPerfDuration('power_sample_bookkeeping_ms', Date.now() - bookkeepingStart);
    await persistPowerSample({
      nextState, currentPowerW, capacityGuard, saveState, rebuildPlanFromCache,
    });
    return;
  }

  const previousTs = state.lastTimestamp as number;
  const previousPower = state.lastPowerW as number;
  const unreliablePeriods = resolveUnreliablePeriods({ state, previousTs, nowMs });

  calculateEnergyAcrossBoundaries({
    startTs: previousTs,
    endTs: nowMs,
    powerW: previousPower,
    buckets: nextBuckets,
    budgets: nextBudgets,
    budgetKWh,
  });

  accumulatePowerIfAvailable({
    previousPowerW: state.lastControlledPowerW,
    nextPowerW: boundedControlledPowerW,
    startTs: previousTs,
    endTs: nowMs,
    buckets: nextControlledBuckets,
  });
  accumulatePowerIfAvailable({
    previousPowerW: state.lastUncontrolledPowerW,
    nextPowerW: boundedUncontrolledPowerW,
    startTs: previousTs,
    endTs: nowMs,
    buckets: nextUncontrolledBuckets,
  });
  accumulatePowerIfAvailable({
    previousPowerW: state.lastExemptPowerW,
    nextPowerW: boundedExemptPowerW,
    startTs: previousTs,
    endTs: nowMs,
    buckets: nextExemptBuckets,
  });
  accumulateDevicePowerIfAvailable({
    previousPowerWById: state.lastDevicePowerWById,
    nextPowerWById: normalizedDevicePowerWById,
    startTs: previousTs,
    endTs: nowMs,
    bucketsByDeviceId: nextDeviceBuckets,
  });

  const nextState = buildNextPowerState({
    state,
    nextBuckets,
    nextHourlySampleCounts,
    nextBudgets,
    nextControlledBuckets,
    nextUncontrolledBuckets,
    nextExemptBuckets,
    nextDeviceBuckets,
    nowMs,
    currentPowerW,
    currentControlledPowerW: boundedControlledPowerW,
    currentUncontrolledPowerW: boundedUncontrolledPowerW,
    currentExemptPowerW: boundedExemptPowerW,
    currentDevicePowerWById: normalizedDevicePowerWById,
    unreliablePeriods,
  });
  addPerfDuration('power_sample_bookkeeping_ms', Date.now() - bookkeepingStart);
  await persistPowerSample({
    nextState, currentPowerW, capacityGuard, saveState, rebuildPlanFromCache,
  });
}
