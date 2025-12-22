import CapacityGuard from './capacityGuard';
import type { PowerTrackerState } from './powerTracker';
import { getHourBucketKey } from './powerTracker';
import type { PlanInputDevice } from './planTypes';

export type PlanContext = {
  devices: PlanInputDevice[];
  desiredForMode: Record<string, number>;
  total: number | null;
  softLimit: number;
  budgetKWh: number;
  usedKWh: number;
  minutesRemaining: number;
  headroomRaw: number | null;
  headroom: number | null;
  restoreMarginPlanning: number;
};

export function buildPlanContext(params: {
  devices: PlanInputDevice[];
  capacityGuard: CapacityGuard | undefined;
  capacitySettings: { limitKw: number; marginKw: number };
  powerTracker: PowerTrackerState;
  softLimit: number;
  desiredForMode: Record<string, number>;
  hourlyBudgetExhausted: boolean;
}): PlanContext {
  const {
    devices,
    capacityGuard,
    capacitySettings,
    powerTracker,
    softLimit,
    desiredForMode,
    hourlyBudgetExhausted,
  } = params;

  const total = capacityGuard ? capacityGuard.getLastTotalPower() : null;

  // Compute used/budget kWh for this hour
  const budgetKWh = Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  const bucketKey = getHourBucketKey();
  const usedKWh = powerTracker.buckets?.[bucketKey] || 0;
  const now = Date.now();
  const hourStart = new Date(bucketKey).getTime();
  const hourEnd = hourStart + 60 * 60 * 1000;
  const minutesRemaining = Math.max(0, (hourEnd - now) / 60000);

  const headroomRaw = total === null ? null : softLimit - total;
  // headroom is the ACTUAL available capacity. Use this for shedding.
  let headroom = headroomRaw === null && softLimit <= 0 ? -1 : headroomRaw;

  // If the hourly energy budget is exhausted and soft limit is zero while instantaneous power reads ~0,
  // force a minimal negative headroom to proactively shed controllable devices.
  if (hourlyBudgetExhausted && softLimit <= 0 && total !== null && total <= 0.01) {
    headroom = -1; // triggers shedding logic with needed ~=1 kW (effectivePower fallback)
  }

  return {
    devices,
    desiredForMode,
    total,
    softLimit,
    budgetKWh,
    usedKWh,
    minutesRemaining,
    headroomRaw,
    headroom,
    restoreMarginPlanning: Math.max(0.1, capacitySettings.marginKw || 0),
  };
}
