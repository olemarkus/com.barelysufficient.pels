import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import type { PowerTrackerState } from '../core/powerTracker';
import type { PlanContext } from './planContext';
import { clamp } from '../utils/mathUtils';
import { isFiniteNumber } from '../utils/appTypeGuards';

export type CurrentHourUsageSplit = {
  totalKWh?: number;
  controlledKWh?: number;
  uncontrolledKWh?: number;
};

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

export function resolveHourlyUsageSplit(params: {
  totalRaw: unknown;
  controlledRaw: unknown;
  uncontrolledRaw: unknown;
}): CurrentHourUsageSplit {
  const { totalRaw, controlledRaw, uncontrolledRaw } = params;
  const hasTotal = isFiniteNumber(totalRaw);
  const hasControlled = isFiniteNumber(controlledRaw);
  const hasUncontrolled = isFiniteNumber(uncontrolledRaw);

  if (hasTotal) {
    const totalKWh = Math.max(0, totalRaw);
    if (hasControlled) {
      const controlledKWh = clamp(controlledRaw, 0, totalKWh);
      return {
        totalKWh,
        controlledKWh,
        uncontrolledKWh: Math.max(0, totalKWh - controlledKWh),
      };
    }
    if (hasUncontrolled) {
      const uncontrolledKWh = clamp(uncontrolledRaw, 0, totalKWh);
      return {
        totalKWh,
        controlledKWh: Math.max(0, totalKWh - uncontrolledKWh),
        uncontrolledKWh,
      };
    }
    return { totalKWh };
  }

  if (hasControlled || hasUncontrolled) {
    return {
      controlledKWh: hasControlled ? Math.max(0, controlledRaw) : undefined,
      uncontrolledKWh: hasUncontrolled ? Math.max(0, uncontrolledRaw) : undefined,
    };
  }

  return {};
}

export function getHourUsageSplit(powerTracker: PowerTrackerState, bucketKey: string): CurrentHourUsageSplit {
  return resolveHourlyUsageSplit({
    totalRaw: powerTracker.buckets?.[bucketKey],
    controlledRaw: powerTracker.controlledBuckets?.[bucketKey],
    uncontrolledRaw: powerTracker.uncontrolledBuckets?.[bucketKey],
  });
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
