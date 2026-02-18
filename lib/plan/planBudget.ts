import type { PowerTrackerState } from '../core/powerTracker';
import { getCurrentHourContext } from './planHourContext';

const SUSTAINABLE_RATE_THRESHOLD_MIN = 10;
const SUSTAINABLE_RATE_THRESHOLD_HOURS = SUSTAINABLE_RATE_THRESHOLD_MIN / 60;

export function computeDynamicSoftLimit(params: {
  capacitySettings: { limitKw: number; marginKw: number };
  powerTracker: PowerTrackerState;
  logDebug: (...args: unknown[]) => void;
}): { allowedKw: number; hourlyBudgetExhausted: boolean } {
  const { capacitySettings, powerTracker, logDebug } = params;
  const budgetKw = capacitySettings.limitKw;
  const { marginKw } = capacitySettings;
  const netBudgetKWh = Math.max(0, budgetKw - marginKw);
  if (netBudgetKWh <= 0) return { allowedKw: 0, hourlyBudgetExhausted: false };

  const now = Date.now();
  const hourContext = getCurrentHourContext(powerTracker, now);
  const remainingHours = Math.max(hourContext.remainingHours, SUSTAINABLE_RATE_THRESHOLD_HOURS);
  const usedKWh = hourContext.usedKWh;
  const remainingKWh = Math.max(0, netBudgetKWh - usedKWh);
  const hourlyBudgetExhausted = remainingKWh <= 0;

  // Calculate instantaneous rate needed to use remaining budget
  const burstRateKw = remainingKWh / remainingHours;

  // Only cap to sustainable rate in the last 10 minutes of the hour.
  // This prevents the "end of hour burst" problem where devices ramp up
  // to use remaining budget, then immediately overshoot the next hour.
  // Earlier in the hour, allow the full burst rate since there's time to recover.
  const minutesRemaining = hourContext.minutesRemaining;
  const sustainableRateKw = netBudgetKWh; // kWh/h = kW at steady state
  const allowedKw = minutesRemaining <= SUSTAINABLE_RATE_THRESHOLD_MIN
    ? Math.min(burstRateKw, sustainableRateKw)
    : burstRateKw;

  logDebug(
    `Soft limit calc: budget=${netBudgetKWh.toFixed(3)}kWh used=${usedKWh.toFixed(3)}kWh `
    + `remaining=${remainingKWh.toFixed(3)}kWh timeLeft=${remainingHours.toFixed(3)}h `
    + `burst=${burstRateKw.toFixed(3)}kW capped=${allowedKw.toFixed(3)}kW`,
  );
  return { allowedKw, hourlyBudgetExhausted };
}

export function computeDailyUsageSoftLimit(params: {
  plannedKWh: number;
  usedKWh: number;
  bucketStartMs: number;
  bucketEndMs: number;
  nowMs?: number;
  logDebug?: (...args: unknown[]) => void;
}): number {
  const {
    plannedKWh,
    usedKWh,
    bucketStartMs,
    bucketEndMs,
    nowMs = Date.now(),
    logDebug,
  } = params;
  if (!Number.isFinite(plannedKWh) || plannedKWh <= 0) return 0;
  if (!Number.isFinite(bucketStartMs) || !Number.isFinite(bucketEndMs) || bucketEndMs <= bucketStartMs) return 0;
  const boundedNowMs = Math.min(Math.max(nowMs, bucketStartMs), bucketEndMs);
  const remainingMs = Math.max(0, bucketEndMs - boundedNowMs);
  const remainingHours = Math.max(remainingMs / 3600000, SUSTAINABLE_RATE_THRESHOLD_HOURS);
  const safeUsed = Number.isFinite(usedKWh) ? Math.max(0, usedKWh) : 0;
  const remainingKWh = Math.max(0, plannedKWh - safeUsed);
  const burstRateKw = remainingKWh / remainingHours;
  // Daily budget is a soft constraint - never apply end-of-hour capping.
  // Only the hourly hard cap needs EOH protection.
  const allowedKw = burstRateKw;
  logDebug?.(
    `Daily soft limit calc: budget=${plannedKWh.toFixed(3)}kWh used=${safeUsed.toFixed(3)}kWh `
    + `remaining=${remainingKWh.toFixed(3)}kWh timeLeft=${remainingHours.toFixed(3)}h `
    + `burst=${burstRateKw.toFixed(3)}kW`,
  );
  return Math.max(0, allowedKw);
}

/**
 * Compute the shortfall threshold for panic mode.
 * Shortfall should only trigger when projected hourly usage would breach the hard cap
 * (limitKw) and no devices are left to shed.
 */
export function computeShortfallThreshold(params: {
  capacitySettings: { limitKw: number; marginKw: number };
  powerTracker: PowerTrackerState;
}): number {
  const { capacitySettings, powerTracker } = params;
  const hardCapBudgetKWh = Math.max(0, capacitySettings.limitKw);
  if (hardCapBudgetKWh <= 0) return 0;

  const now = Date.now();
  const hourContext = getCurrentHourContext(powerTracker, now);
  const remainingHours = Math.max(hourContext.remainingHours, 0.01);
  const usedKWh = hourContext.usedKWh;
  const remainingKWh = Math.max(0, hardCapBudgetKWh - usedKWh);

  // Return the uncapped burst rate before the hard-cap hourly budget would be exceeded.
  return remainingKWh / remainingHours;
}
