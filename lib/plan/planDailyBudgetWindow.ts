import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import type { PowerTrackerState } from '../core/powerTracker';
import type { PlanContext } from './planContext';
import { getHourBucketKey } from '../utils/dateUtils';

type DailySoftLimitBucket = {
  plannedKWh: number;
  usedKWh: number;
  bucketStartMs: number;
  bucketEndMs: number;
};

type DailySoftLimitInput = {
  plannedKWh: number;
  bucketStartIso: string;
  nextBucketStartIso?: string;
};

export function getCurrentHourKWh(buckets?: Record<string, number>): number | undefined {
  const value = buckets?.[getHourBucketKey()];
  return typeof value === 'number' ? value : undefined;
}

export function resolveDailySoftLimitBucket(
  snapshot: DailyBudgetUiPayload | null,
  powerTracker: PowerTrackerState,
): DailySoftLimitBucket | null {
  const input = resolveDailySoftLimitInput(snapshot);
  if (!input) return null;
  const window = resolveDailySoftLimitWindow(input);
  if (!window) return null;
  const meteredUsedKWh = powerTracker.buckets?.[input.bucketStartIso] ?? 0;
  const exemptUsedKWh = powerTracker.exemptBuckets?.[input.bucketStartIso] ?? 0;
  return {
    plannedKWh: input.plannedKWh,
    usedKWh: Math.max(0, meteredUsedKWh - exemptUsedKWh),
    ...window,
  };
}

export function extractDailyBudgetHourKWh(snapshot: DailyBudgetUiPayload | null): number | undefined {
  const today = getTodayDailyBudget(snapshot);
  if (!today?.budget.enabled) return undefined;
  const plannedKWh = today.buckets.plannedKWh;
  const index = today.currentBucketIndex;
  if (!Array.isArray(plannedKWh) || index < 0 || index >= plannedKWh.length) return undefined;
  const value = plannedKWh[index];
  return Number.isFinite(value) ? value : undefined;
}

export function buildDailyBudgetContext(
  snapshot: DailyBudgetUiPayload | null,
): PlanContext['dailyBudget'] | undefined {
  const today = getTodayDailyBudget(snapshot);
  if (!today) return undefined;
  return {
    enabled: today.budget.enabled,
    usedNowKWh: today.state.usedNowKWh,
    allowedNowKWh: today.state.allowedNowKWh,
    remainingKWh: today.state.remainingKWh,
    exceeded: today.state.exceeded,
    frozen: today.state.frozen,
  };
}

function getTodayDailyBudget(snapshot: DailyBudgetUiPayload | null) {
  if (!snapshot) return null;
  return snapshot.days[snapshot.todayKey] ?? null;
}

function resolveDailySoftLimitInput(snapshot: DailyBudgetUiPayload | null): DailySoftLimitInput | null {
  const today = snapshot?.days[snapshot.todayKey];
  if (!today?.budget.enabled) return null;
  const plannedKWh = today.buckets.plannedKWh;
  const bucketStartUtc = today.buckets.startUtc;
  const index = today.currentBucketIndex;
  if (!Array.isArray(plannedKWh) || !Array.isArray(bucketStartUtc)) return null;
  if (index < 0 || index >= plannedKWh.length || index >= bucketStartUtc.length) return null;
  const planned = plannedKWh[index];
  if (!Number.isFinite(planned)) return null;
  return {
    plannedKWh: planned,
    bucketStartIso: bucketStartUtc[index],
    nextBucketStartIso: index + 1 < bucketStartUtc.length ? bucketStartUtc[index + 1] : undefined,
  };
}

function resolveDailySoftLimitWindow(
  input: DailySoftLimitInput,
): Pick<DailySoftLimitBucket, 'bucketStartMs' | 'bucketEndMs'> | null {
  const bucketStartMs = new Date(input.bucketStartIso).getTime();
  if (!Number.isFinite(bucketStartMs)) return null;
  const bucketEndMs = input.nextBucketStartIso
    ? new Date(input.nextBucketStartIso).getTime()
    : bucketStartMs + 60 * 60 * 1000;
  if (!Number.isFinite(bucketEndMs)) return null;
  return { bucketStartMs, bucketEndMs };
}
