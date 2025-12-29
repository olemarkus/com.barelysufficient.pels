import CapacityGuard from '../core/capacityGuard';
import type { PowerTrackerState } from '../core/powerTracker';
import { getCurrentHourContext } from './planHourContext';
import type { PlanInputDevice } from './planTypes';
import type { DailyBudgetAggressiveness } from '../dailyBudget/dailyBudgetTypes';

export type DailyBudgetContext = {
  enabled: boolean;
  pressure: number;
  aggressiveness: DailyBudgetAggressiveness;
  usedNowKWh: number;
  allowedNowKWh: number;
  remainingKWh: number;
  exceeded: boolean;
  frozen: boolean;
};

export type SoftLimitSource = 'capacity' | 'daily' | 'both';

export type PlanContext = {
  devices: PlanInputDevice[];
  desiredForMode: Record<string, number>;
  total: number | null;
  softLimit: number;
  capacitySoftLimit: number;
  dailySoftLimit: number | null;
  softLimitSource: SoftLimitSource;
  budgetKWh: number;
  usedKWh: number;
  minutesRemaining: number;
  headroomRaw: number | null;
  headroom: number | null;
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

  const total = capacityGuard ? capacityGuard.getLastTotalPower() : null;

  // Compute used/budget kWh for this hour
  const budgetKWh = Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
  const now = Date.now();
  const hourContext = getCurrentHourContext(powerTracker, now);
  const usedKWh = hourContext.usedKWh;
  const minutesRemaining = hourContext.minutesRemaining;

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
