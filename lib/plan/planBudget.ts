/**
 * Producer of both safe-pace thresholds.
 *
 * `notes/safe-pace-two-constraints.md` is the definition of record for the names
 * and for why these are two constraints rather than one. They do not measure the
 * same load: the capacity pace counts all of net grid import, while the budget
 * pace counts net import minus exempt draw. Note that is net, not gross house
 * consumption — the two diverge on a solar home. Neither function rebases the
 * other's axis: `planBuilder` does that with the projected exempt sum for the
 * binding pace, and `planContext` with the measured sum for the per-axis restore
 * admission budget. See `lib/plan/AGENTS.md` § "Terminology" for the full set.
 *
 * The other asymmetry callers depend on is that only the capacity pace is held
 * back at the capacity-period boundary (`notes/end-of-hour-mode.md`); the budget
 * pace deliberately applies no such ceiling.
 */
import type { PowerTrackerState } from '../power/tracker';
import type { CapacitySettings } from '../../packages/contracts/src/capacitySettings';
import { resolveHardCapacityKWh, resolveUsableCapacityKWh, resolveUsableCapacityKw } from '../power/capacityModel';
import { getCurrentCapacityPeriodContext } from './planHourContext';

// Floor on the remaining-time divisor for the burst rate, so the rate stays
// finite as the period ends (avoids remaining/→0 blow-up). Shared by capacity
// and daily pacing calculations.
const BURST_RATE_MIN_REMAINING_MIN = 10;
const BURST_RATE_MIN_REMAINING_HOURS = BURST_RATE_MIN_REMAINING_MIN / 60;
// A quarter's pace is capped at the sustainable rate, so the cap, not this
// floor, keeps it finite as the quarter ends. The floor only has to stop a
// division by zero, and it must not overstate the time left: a one-minute floor
// read "0.06 kWh left with 12 s to go" as 3.6 kW rather than 17 kW, and a quarter
// running just under the pace shed a device seconds before its boundary (SHS,
// 2026-09-19). One Homey Energy poll (10 s) is the shortest span a decision can
// act on.
const QUARTER_BURST_RATE_MIN_REMAINING_HOURS = 10 / 3600;

// Base period-end drain time-constant (minutes). The capacity safe pace is capped by
// an exponential ceiling that decays toward the steady sustainable rate as the
// period ends — `sustainable · e^(minutesRemaining / TAU)` — so managed devices
// are wound down gradually over the final minutes instead of cliff-shed at a
// fixed threshold. The ceiling is ~sustainable at :00 and far above any feasible
// burst earlier in the period (so the budget-driven burst rate governs then).
// Hourly control only: a quarter never bursts above the sustainable rate, so it
// has nothing to drain. See notes/end-of-hour-mode.md for the rationale and the
// TAU trade-off.
const EOH_DRAIN_TAU_MIN = 4;

/**
 * Returns `capacityPaceKw` as `allowedKw` — the dynamic selected-period threshold on the
 * import axis. It is not `hardCapKw`: it budgets the allowance over the time left
 * in the period. In an under-used hour it legitimately sits above the configured
 * ceiling, and crossing it is not crossing the tariff step. A quarter never goes
 * above the sustainable rate (`notes/capacity-periods.md` § "Control rule").
 */
export function computeDynamicSoftLimit(
  capacitySettings: CapacitySettings,
  powerTracker: PowerTrackerState,
  nowMs: number,
): {
  allowedKw: number;
  hourlyBudgetExhausted: boolean;
  remainingKWh: number;
} {
  const netBudgetKWh = resolveUsableCapacityKWh(capacitySettings);
  if (netBudgetKWh <= 0) return { allowedKw: 0, hourlyBudgetExhausted: false, remainingKWh: 0 };

  const periodContext = getCurrentCapacityPeriodContext(powerTracker, capacitySettings.periodMinutes, nowMs);
  if (!periodContext.coverageComplete) {
    return { allowedKw: 0, hourlyBudgetExhausted: false, remainingKWh: 0 };
  }
  const minimumRemainingHours = capacitySettings.periodMinutes === 15
    ? QUARTER_BURST_RATE_MIN_REMAINING_HOURS
    : BURST_RATE_MIN_REMAINING_HOURS;
  const remainingHours = Math.max(periodContext.remainingHours, minimumRemainingHours);
  const usedKWh = periodContext.usedKWh;
  const remainingKWh = Math.max(0, netBudgetKWh - usedKWh);
  const hourlyBudgetExhausted = remainingKWh <= 0;

  // Calculate instantaneous rate needed to use remaining budget
  const burstRateKw = remainingKWh / remainingHours;

  const sustainableRateKw = resolveUsableCapacityKw(capacitySettings);
  // A quarter is too short to spend saved allowance safely: a burst late in the
  // quarter leaves no time to wind down (shed and restore cooldowns alone are a
  // minute or more), so it ends in a batch shed in the last seconds. Cap the pace
  // at the sustainable rate instead and let the safety margin be the buffer. The
  // burst rate still binds below it, so a heavy start is recovered.
  if (capacitySettings.periodMinutes === 15) {
    return { allowedKw: Math.min(burstRateKw, sustainableRateKw), hourlyBudgetExhausted, remainingKWh };
  }

  // Period-end drain: cap the burst rate by an exponential ceiling that decays
  // toward the steady sustainable rate as the hour ends. This prevents a
  // boundary burst (devices ramping up to spend remaining budget then carrying
  // that draw into the next period) while winding devices down gradually.
  // Earlier in the hour the ceiling sits far above any feasible burst, so the
  // budget-driven burst rate governs and there is time to recover.
  const drainCeilingKw = sustainableRateKw * Math.exp(periodContext.minutesRemaining / EOH_DRAIN_TAU_MIN);
  const allowedKw = Math.min(burstRateKw, drainCeilingKw);

  // `remainingKWh` travels out because it is the only honest price of waiting:
  // the shed grace spends it, and it is already computed here.
  return { allowedKw, hourlyBudgetExhausted, remainingKWh };
}

/**
 * Returns `budgetPaceKw`: the daily-budget threshold on the **non-exempt** axis,
 * so it is not directly comparable with `capacityPaceKw`. `planBuilder` rebases it
 * onto the import axis by adding `projectedExemptKw` before the two are compared
 * (`dailySoftLimitKw` in `computeDailySoftLimit`, canonically `budgetPaceImportKw`
 * — see `notes/safe-pace-two-constraints.md`).
 *
 * The window is the current bucket of the daily plan, not the whole day, so this
 * paces that bucket's share rather than a whole-day burst rate.
 */
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
  // Daily budget is a soft constraint - never apply capacity-period capping.
  // Only the selected-period hard cap needs boundary protection.
  const allowedKw = burstRateKw;
  return Math.max(0, allowedKw);
}

/**
 * Compute the shortfall threshold for panic mode.
 * Shortfall should only trigger when projected selected-period usage would breach the hard cap
 * (limitKw) and no devices are left to shed.
 */
export function computeShortfallThreshold(
  capacitySettings: CapacitySettings,
  powerTracker: PowerTrackerState,
  nowMs: number,
): number {
  const hardCapBudgetKWh = resolveHardCapacityKWh(capacitySettings);
  if (hardCapBudgetKWh <= 0) return 0;

  const periodContext = getCurrentCapacityPeriodContext(powerTracker, capacitySettings.periodMinutes, nowMs);
  if (!periodContext.coverageComplete) return 0;
  const remainingHours = Math.max(periodContext.remainingHours, 0.01);
  const usedKWh = periodContext.usedKWh;
  const remainingKWh = Math.max(0, hardCapBudgetKWh - usedKWh);

  // Return the uncapped burst rate before the hard-cap period budget would be exceeded.
  return remainingKWh / remainingHours;
}
