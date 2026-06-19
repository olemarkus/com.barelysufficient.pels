import type { PowerTrackerState } from '../power/tracker';
import { resolveUsableCapacityKw } from '../power/capacityModel';
import { getCurrentHourContext } from './planHourContext';

// Floor on the remaining-time divisor for the burst rate, so the rate stays
// finite as the hour ends (avoids remaining/→0 blow-up). Shared by the hourly
// and daily pacing calculations.
const BURST_RATE_MIN_REMAINING_MIN = 10;
const BURST_RATE_MIN_REMAINING_HOURS = BURST_RATE_MIN_REMAINING_MIN / 60;

// End-of-hour drain time-constant (minutes). The hourly safe pace is capped by
// an exponential ceiling that decays toward the steady sustainable rate as the
// hour ends — `sustainable · e^(minutesRemaining / TAU)` — so managed devices
// are wound down gradually over the final minutes instead of cliff-shed at a
// fixed threshold. The ceiling is ~sustainable at :00 and far above any feasible
// burst earlier in the hour (so the budget-driven burst rate governs then). See
// notes/end-of-hour-mode.md for the rationale and the TAU trade-off.
const EOH_DRAIN_TAU_MIN = 4;

export function computeDynamicSoftLimit(params: {
  capacitySettings: { limitKw: number; marginKw: number };
  powerTracker: PowerTrackerState;
}): { allowedKw: number; hourlyBudgetExhausted: boolean } {
  const { capacitySettings, powerTracker } = params;
  const netBudgetKWh = resolveUsableCapacityKw(capacitySettings);
  if (netBudgetKWh <= 0) return { allowedKw: 0, hourlyBudgetExhausted: false };

  const now = Date.now();
  const hourContext = getCurrentHourContext(powerTracker, now);
  const remainingHours = Math.max(hourContext.remainingHours, BURST_RATE_MIN_REMAINING_HOURS);
  const usedKWh = hourContext.usedKWh;
  const remainingKWh = Math.max(0, netBudgetKWh - usedKWh);
  const hourlyBudgetExhausted = remainingKWh <= 0;

  // Calculate instantaneous rate needed to use remaining budget
  const burstRateKw = remainingKWh / remainingHours;

  // End-of-hour drain: cap the burst rate by an exponential ceiling that decays
  // toward the steady sustainable rate as the hour ends. This prevents the "end
  // of hour burst" (devices ramping up to spend remaining budget then overshooting
  // the next hour) while winding devices down gradually instead of in one cliff.
  // Earlier in the hour the ceiling sits far above any feasible burst, so the
  // budget-driven burst rate governs and there is time to recover.
  const sustainableRateKw = netBudgetKWh; // kWh/h = kW at steady state
  const drainCeilingKw = sustainableRateKw * Math.exp(hourContext.minutesRemaining / EOH_DRAIN_TAU_MIN);
  const allowedKw = Math.min(burstRateKw, drainCeilingKw);

  return { allowedKw, hourlyBudgetExhausted };
}

export function computeDailyUsageSoftLimit(params: {
  plannedKWh: number;
  usedKWh: number;
  bucketStartMs: number;
  bucketEndMs: number;
  nowMs?: number;
}): number {
  const {
    plannedKWh,
    usedKWh,
    bucketStartMs,
    bucketEndMs,
    nowMs = Date.now(),
  } = params;
  if (!Number.isFinite(plannedKWh) || plannedKWh <= 0) return 0;
  if (!Number.isFinite(bucketStartMs) || !Number.isFinite(bucketEndMs) || bucketEndMs <= bucketStartMs) return 0;
  const boundedNowMs = Math.min(Math.max(nowMs, bucketStartMs), bucketEndMs);
  const remainingMs = Math.max(0, bucketEndMs - boundedNowMs);
  const remainingHours = Math.max(remainingMs / 3600000, BURST_RATE_MIN_REMAINING_HOURS);
  const safeUsed = Number.isFinite(usedKWh) ? Math.max(0, usedKWh) : 0;
  const remainingKWh = Math.max(0, plannedKWh - safeUsed);
  const burstRateKw = remainingKWh / remainingHours;
  // Daily budget is a soft constraint - never apply end-of-hour capping.
  // Only the hourly hard cap needs EOH protection.
  const allowedKw = burstRateKw;
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
