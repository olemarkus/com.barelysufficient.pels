import Homey from 'homey';
import CapacityGuard from './capacityGuard';
import { truncateToUtcHour, getHourBucketKey } from '../utils/dateUtils';

export const HOURLY_RETENTION_DAYS = 30; // Keep detailed hourly data for 30 days
export const DAILY_RETENTION_DAYS = 365; // Keep daily totals for 1 year

export type PowerTrackerState = {
  lastPowerW?: number;
  lastControlledPowerW?: number;
  lastUncontrolledPowerW?: number;
  lastTimestamp?: number;
  buckets?: Record<string, number>; // Hourly data (ISO timestamp -> kWh)
  hourlyBudgets?: Record<string, number>; // Hourly budget snapshot (ISO timestamp -> kWh)
  dailyBudgetCaps?: Record<string, number>; // Daily budget plan per hour (ISO timestamp -> kWh)
  dailyTotals?: Record<string, number>; // Daily totals (YYYY-MM-DD -> kWh)
  hourlyAverages?: Record<string, { sum: number; count: number }>; // day-hour pattern (0-6_0-23 -> { sum, count })
  controlledBuckets?: Record<string, number>;
  uncontrolledBuckets?: Record<string, number>;
  controlledDailyTotals?: Record<string, number>;
  uncontrolledDailyTotals?: Record<string, number>;
  controlledHourlyAverages?: Record<string, { sum: number; count: number }>;
  uncontrolledHourlyAverages?: Record<string, { sum: number; count: number }>;
  unreliablePeriods?: Array<{ start: number; end: number }>; // Periods where data is missing/unreliable
};

export type RecordPowerSampleParams = {
  state: PowerTrackerState;
  currentPowerW: number;
  controlledPowerW?: number;
  nowMs?: number;
  homey: Homey.App['homey'];
  capacityGuard?: CapacityGuard;
  hourBudgetKWh?: number;
  rebuildPlanFromCache: () => Promise<void>;
  saveState: (state: PowerTrackerState) => void;
};

const MIN_VALID_TIMESTAMP_MS = 100000000000;
const MAX_SAMPLE_GAP_MS = 48 * 60 * 60 * 1000;
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
  nextBudgets: Map<string, number>;
  nextControlledBuckets?: Map<string, number>;
  nextUncontrolledBuckets?: Map<string, number>;
  nowMs: number;
  currentPowerW: number;
  currentControlledPowerW?: number;
  currentUncontrolledPowerW?: number;
  unreliablePeriods?: Array<{ start: number; end: number }>;
}): PowerTrackerState {
  const {
    state,
    nextBuckets,
    nextBudgets,
    nextControlledBuckets,
    nextUncontrolledBuckets,
    nowMs,
    currentPowerW,
    currentControlledPowerW,
    currentUncontrolledPowerW,
    unreliablePeriods,
  } = params;
  return {
    ...state,
    buckets: Object.fromEntries(nextBuckets),
    hourlyBudgets: Object.fromEntries(nextBudgets),
    controlledBuckets: nextControlledBuckets ? Object.fromEntries(nextControlledBuckets) : state.controlledBuckets,
    uncontrolledBuckets: nextUncontrolledBuckets ? Object.fromEntries(nextUncontrolledBuckets) : state.uncontrolledBuckets,
    lastTimestamp: nowMs,
    lastPowerW: currentPowerW,
    lastControlledPowerW: currentControlledPowerW,
    lastUncontrolledPowerW: currentUncontrolledPowerW,
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

function resolveControlledSample(params: {
  currentPowerW: number;
  controlledPowerW?: number;
}): ControlledSample {
  const { currentPowerW, controlledPowerW } = params;
  if (typeof controlledPowerW !== 'number' || !Number.isFinite(controlledPowerW)) {
    return {};
  }
  const boundedControlled = Math.max(0, Math.min(controlledPowerW, currentPowerW));
  return {
    controlledPowerW: boundedControlled,
    uncontrolledPowerW: Math.max(0, currentPowerW - boundedControlled),
  };
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
          const date = new Date(isoKey);
          const dateKey = formatDateUtc(date);
          const hourOfDay = getUtcHour(date);
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
    hourlyBudgets: Object.fromEntries(nextBudgets),
    dailyBudgetCaps: Object.fromEntries(nextDailyCaps),
    dailyTotals: totalAggregate.dailyTotals,
    hourlyAverages: totalAggregate.hourlyAverages,
    controlledBuckets: controlledAggregate.buckets,
    uncontrolledBuckets: uncontrolledAggregate.buckets,
    controlledDailyTotals: controlledAggregate.dailyTotals,
    uncontrolledDailyTotals: uncontrolledAggregate.dailyTotals,
    controlledHourlyAverages: controlledAggregate.hourlyAverages,
    uncontrolledHourlyAverages: uncontrolledAggregate.hourlyAverages,
    unreliablePeriods: (state.unreliablePeriods || []).filter((p) => p.end >= hourlyThreshold),
  };
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
    state, currentPowerW, controlledPowerW, nowMs = Date.now(), capacityGuard,
    hourBudgetKWh, rebuildPlanFromCache, saveState,
  } = params;

  const nextBuckets = new Map<string, number>(Object.entries(state.buckets || {}));
  const nextBudgets = new Map<string, number>(Object.entries(state.hourlyBudgets || {}));
  const nextControlledBuckets = new Map<string, number>(Object.entries(state.controlledBuckets || {}));
  const nextUncontrolledBuckets = new Map<string, number>(Object.entries(state.uncontrolledBuckets || {}));
  const budgetKWh = typeof hourBudgetKWh === 'number' ? hourBudgetKWh : null;
  if (budgetKWh !== null) {
    nextBudgets.set(getHourBucketKey(nowMs), budgetKWh);
  }

  const { controlledPowerW: boundedControlledPowerW, uncontrolledPowerW: boundedUncontrolledPowerW } = resolveControlledSample({
    currentPowerW,
    controlledPowerW,
  });

  if (shouldResetSamplingState(state, nowMs)) {
    const nextState = buildNextPowerState({
      state,
      nextBuckets,
      nextBudgets,
      nextControlledBuckets,
      nextUncontrolledBuckets,
      nowMs,
      currentPowerW,
      currentControlledPowerW: boundedControlledPowerW,
      currentUncontrolledPowerW: boundedUncontrolledPowerW,
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

  const nextState = buildNextPowerState({
    state,
    nextBuckets,
    nextBudgets,
    nextControlledBuckets,
    nextUncontrolledBuckets,
    nowMs,
    currentPowerW,
    currentControlledPowerW: boundedControlledPowerW,
    currentUncontrolledPowerW: boundedUncontrolledPowerW,
    unreliablePeriods,
  });
  await persistPowerSample({
    nextState, currentPowerW, capacityGuard, saveState, rebuildPlanFromCache,
  });
}
