import CapacityGuard from '../core/capacityGuard';
import { resolveUsableCapacityKw } from '../core/capacityModel';
import type { PowerTrackerState } from '../core/powerTracker';
import { getCurrentHourContext } from './planHourContext';
import { resolvePowerSampleFreshness, type PowerFreshnessState } from './planPowerFreshness';
import type { PlanInputDevice } from './planTypes';

export type DailyBudgetContext = {
  enabled: boolean;
  usedNowKWh: number;
  allowedNowKWh: number;
  remainingKWh: number;
  exceeded: boolean;
  frozen: boolean;
};

export type SoftLimitSource = 'capacity' | 'daily';

export type PlanContext = {
  devices: PlanInputDevice[];
  desiredForMode: Record<string, number>;
  total: number | null;
  powerKnown: boolean;
  hasLivePowerSample: boolean;
  powerSampleAgeMs: number | null;
  powerFreshnessState: PowerFreshnessState;
  softLimit: number;
  capacitySoftLimit: number;
  dailySoftLimit: number | null;
  softLimitSource: SoftLimitSource;
  budgetKWh: number;
  usedKWh: number;
  minutesRemaining: number;
  headroomRaw: number;
  headroom: number;
  restoreMarginPlanning: number;
  dailyBudget?: DailyBudgetContext;
};

export function buildPlanContext(params: {
  devices: PlanInputDevice[];
  capacityGuard: CapacityGuard | undefined;
  capacitySettings: { limitKw: number; marginKw: number };
  powerTracker: PowerTrackerState;
  softLimit: number;
  capacitySoftLimit: number;
  dailySoftLimit: number | null;
  softLimitSource: SoftLimitSource;
  desiredForMode: Record<string, number>;
  hourlyBudgetExhausted: boolean;
  dailyBudget?: DailyBudgetContext;
}): PlanContext {
  const {
    devices,
    capacityGuard,
    capacitySettings,
    powerTracker,
    softLimit,
    capacitySoftLimit,
    dailySoftLimit,
    softLimitSource,
    desiredForMode,
    hourlyBudgetExhausted,
    dailyBudget,
  } = params;

  const now = Date.now();
  const total = capacityGuard ? capacityGuard.getLastTotalPower() : null;
  const freshness = resolvePowerSampleFreshness(powerTracker, now);
  const powerKnown = freshness.powerFreshnessState === 'fresh' && total !== null;

  // Compute used/budget kWh for this hour
  const budgetKWh = resolveUsableCapacityKw(capacitySettings);
  const hourContext = getCurrentHourContext(powerTracker, now);
  const usedKWh = hourContext.usedKWh;
  const minutesRemaining = hourContext.minutesRemaining;

  let headroomRaw = 0;
  if (powerKnown && total !== null) {
    headroomRaw = softLimit - total;
  } else if (freshness.powerFreshnessState === 'stale_fail_closed') {
    headroomRaw = -1;
  }
  // headroom is the ACTUAL available capacity. Use this for shedding.
  let headroom = headroomRaw;

  // If the hourly energy budget is exhausted and soft limit is zero while instantaneous power reads ~0,
  // force a minimal negative headroom to proactively shed controllable devices.
  if (hourlyBudgetExhausted && softLimit <= 0 && total !== null && total <= 0.01) {
    headroom = -1; // triggers shedding logic with needed ~=1 kW (effectivePower fallback)
  }

  return {
    devices,
    desiredForMode,
    total,
    powerKnown,
    hasLivePowerSample: freshness.hasLivePowerSample,
    powerSampleAgeMs: freshness.powerSampleAgeMs,
    powerFreshnessState: freshness.powerFreshnessState,
    softLimit,
    capacitySoftLimit,
    dailySoftLimit,
    softLimitSource,
    budgetKWh,
    usedKWh,
    minutesRemaining,
    headroomRaw,
    headroom,
    restoreMarginPlanning: Math.max(0.1, capacitySettings.marginKw || 0),
    dailyBudget,
  };
}
