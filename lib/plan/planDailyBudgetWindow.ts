import type { DailyBudgetUiPayload } from '../dailyBudget/dailyBudgetTypes';
import type { PowerTrackerState } from '../power/tracker';
import { EnergyAccounting } from '../power/energyAccounting';

export type CurrentHourUsageSplit = {
  totalKWh?: number;
  controlledKWh?: number;
  uncontrolledKWh?: number;
};

/** One daily-budget bucket's plan and its window: what paces that bucket. */
export type DailySoftLimitBucket = {
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

export function getHourUsageSplit(powerTracker: PowerTrackerState, bucketKey: string): CurrentHourUsageSplit {
  return new EnergyAccounting(powerTracker).hourUsage(bucketKey);
}

/**
 * The bucket the snapshot calls current, while it still is. A rebuild no
 * reading drove (a settings change, a Flow card) runs against the snapshot the
 * last reading computed, which in the first moments of a new bucket still
 * names the bucket just ended. Pacing the new bucket from that one's leftover
 * would apply an arbitrary limit, so an ended bucket paces nothing; the first
 * reading in the new bucket recomputes the snapshot.
 */
export function resolveDailySoftLimitBucket(
  snapshot: DailyBudgetUiPayload | null,
  powerTracker: PowerTrackerState,
  nowMs: number,
): DailySoftLimitBucket | null {
  const input = resolveDailySoftLimitInput(snapshot);
  if (!input) return null;
  const window = resolveDailySoftLimitWindow(input);
  if (!window || nowMs >= window.bucketEndMs) return null;
  const usage = new EnergyAccounting(powerTracker).bucket(input.bucketStartIso);
  return {
    plannedKWh: input.plannedKWh,
    usedKWh: usage.budgetCountedKwh,
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
  const bucketStartIso = bucketStartUtc[index];
  if (!Number.isFinite(planned) || planned === undefined || bucketStartIso === undefined) return null;
  return {
    plannedKWh: planned,
    bucketStartIso,
    nextBucketStartIso: bucketStartUtc[index + 1],
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
