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
import type CapacityGuard from '../power/capacityGuard';
import { resolveLastTotalPowerKw } from '../power/lastTotalPower';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from '../power/tracker';
import type { CapacityPeriodMinutes, CapacitySettings } from '../../packages/contracts/src/capacitySettings';
import type { PlanContext } from './planContext';
import {
  resolveHardCapacityKWh, resolvePlanningCeilingKw, resolveUsableCapacityKWh, resolveUsableCapacityKw,
} from '../power/capacityModel';
import { getCurrentCapacityPeriodContext } from './planHourContext';
import type { DrainStart } from './capacityDrainStart';
import type { DailySoftLimitBucket } from './planDailyBudgetWindow';
import type { DailyBudgetUiPayload } from '../../packages/contracts/src/dailyBudgetTypes';

// Daily pacing retains its divisor floor; it has no period-end drain ceiling.
const DAILY_BURST_RATE_MIN_REMAINING_HOURS = 10 / 60;
// A quarter's pace is capped at the sustainable rate, so the cap, not this
// floor, keeps it finite as the quarter ends. The floor only has to stop a
// division by zero, and it must not overstate the time left: a one-minute floor
// read "0.06 kWh left with 12 s to go" as 3.6 kW rather than 17 kW, and a quarter
// running just under the pace shed a device seconds before its boundary (SHS,
// 2026-09-19). One Homey Energy poll (10 s) is the shortest span a decision can
// act on.
const QUARTER_BURST_RATE_MIN_REMAINING_HOURS = 10 / 3600;

// End-of-hour drain (hourly control only; a quarter never bursts above the
// sustainable rate, so it has nothing to drain). Over the last
// EOH_DRAIN_WINDOW_MIN minutes the capacity safe pace falls from what the house
// drew when the window opened to the sustainable rate at :00, the average the
// next hour must hold, so the next hour does not start over its limit. The
// curve is exponential with time constant EOH_DRAIN_TAU_MIN: small cuts first,
// the largest near the end. See notes/end-of-hour-mode.md.
const EOH_DRAIN_WINDOW_MIN = 10;
const EOH_DRAIN_TAU_MIN = 4;
const EOH_DRAIN_SPAN = Math.expm1(EOH_DRAIN_WINDOW_MIN / EOH_DRAIN_TAU_MIN);

/** Whether the hourly end-of-hour drain is in force with this many minutes left. */
export function isInEndOfHourDrain(periodMinutes: CapacityPeriodMinutes, minutesRemaining: number): boolean {
  return periodMinutes === 60 && minutesRemaining <= EOH_DRAIN_WINDOW_MIN;
}

/**
 * The share of the window's starting excess over the sustainable rate still
 * allowed with `minutesRemaining` left: 1 when the window opens, 0 at :00, and
 * falling fastest in the final minutes.
 */
function drainShare(minutesRemaining: number): number {
  return 1 - Math.expm1((EOH_DRAIN_WINDOW_MIN - minutesRemaining) / EOH_DRAIN_TAU_MIN) / EOH_DRAIN_SPAN;
}

/**
 * Whether the daily budget sits below the home's planning ceiling
 * (`resolvePlanningPowerCeiling`) for the actual local day. Bucket count is the
 * day length, so DST days correctly use 23 or 25 hours. A disabled or
 * unavailable budget cannot create pressure. With no power limit enabled
 * nothing else caps the day, so an enabled budget is always the binding one.
 */
export function isDailyBudgetBelowPlanningCeiling(
  snapshot: DailyBudgetUiPayload | null,
  settings: PowerLimitSettings,
): boolean {
  if (snapshot === null) return false;
  const day = snapshot.days[snapshot.todayKey];
  if (day === undefined || !day.budget.enabled) return false;
  const ceilingKw = resolvePlanningCeilingKw(settings);
  return ceilingKw === null || day.budget.dailyBudgetKWh < ceilingKw * day.buckets.startUtc.length;
}

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
  /** Where this hour's drain falls from (`CapacityDrainStart`); read only inside the window. */
  drainStart: DrainStart,
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
  // Hourly pacing uses the actual time left; the drain bounds the burst rate.
  // At :00 the context rolls into the next hour, so its divisor stays positive.
  const remainingHours = capacitySettings.periodMinutes === 15
    ? Math.max(periodContext.remainingHours, QUARTER_BURST_RATE_MIN_REMAINING_HOURS)
    : periodContext.remainingHours;
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

  // End-of-hour drain: from the draw the window opened at down to the
  // sustainable rate at :00, so the house enters the next hour at its target
  // rather than spending a leftover allowance and carrying that draw across.
  // Before the window the budget-driven burst rate governs.
  if (!isInEndOfHourDrain(capacitySettings.periodMinutes, periodContext.minutesRemaining)) {
    return { allowedKw: burstRateKw, hourlyBudgetExhausted, remainingKWh };
  }
  // Scaled from the minute the drain started, so a drain first seen after :50
  // (a restart inside the window) also opens at the house's draw.
  const excessKw = Math.max(0, drainStart.drawKw - sustainableRateKw);
  const startShare = drainShare(drainStart.minutesRemaining);
  const shareLeft = startShare > 0 ? Math.min(1, drainShare(periodContext.minutesRemaining) / startShare) : 0;
  const drainCeilingKw = sustainableRateKw + excessKw * shareLeft;
  const allowedKw = Math.min(burstRateKw, drainCeilingKw);

  // The remaining allowance is a period fact used for exhaustion and display.
  // Discretionary pacing patience has its own configured-margin allowance.
  return { allowedKw, hourlyBudgetExhausted, remainingKWh };
}

/**
 * The capacity headroom an increase (a restore or a step up) may spend, given
 * the cycle's `capacityHeadroomKw`. Inside the end-of-hour drain that is the
 * room under the lower of the pace and the sustainable rate: a device turned
 * on then keeps running into the next hour, so it has to fit that hour's
 * target, and anything more would be limited again before :00. Shedding keeps
 * reading the drain pace itself. `null` with Capacity limit off. The window is
 * hourly only, so `budgetKWh` is the sustainable rate in kW.
 */
export function resolveCapacityAdmissionHeadroomKw(
  context: Pick<PlanContext, 'capacitySoftLimit' | 'capacityPeriodMinutes' | 'minutesRemaining' | 'budgetKWh'>,
  capacityHeadroomKw: number | null,
): number | null {
  return capacityHeadroomKw === null ? null : capacityHeadroomKw - resolveCapacityAdmissionCutKw(context);
}

/**
 * The capacity room the end-of-hour drain withholds from an increase
 * (`resolveCapacityAdmissionHeadroomKw`): the pace above the sustainable rate
 * inside the window, 0 outside it, in a quarter and with Capacity limit off.
 * A hold that this room alone would lift reads `endOfHourDrain`
 * (`isDrainReleasableHold`).
 */
export function resolveCapacityAdmissionCutKw(
  context: Pick<PlanContext, 'capacitySoftLimit' | 'capacityPeriodMinutes' | 'minutesRemaining' | 'budgetKWh'>,
): number {
  if (context.capacitySoftLimit === null) return 0;
  if (!isInEndOfHourDrain(context.capacityPeriodMinutes, context.minutesRemaining)) return 0;
  return Math.max(0, context.capacitySoftLimit - context.budgetKWh);
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
export function computeDailyUsageSoftLimit(bucket: DailySoftLimitBucket, nowMs: number): number {
  const {
    plannedKWh, usedKWh, bucketStartMs, bucketEndMs,
  } = bucket;
  if (!Number.isFinite(plannedKWh) || plannedKWh <= 0) return 0;
  if (!Number.isFinite(bucketStartMs) || !Number.isFinite(bucketEndMs) || bucketEndMs <= bucketStartMs) return 0;
  const remainingMs = bucketEndMs - Math.max(nowMs, bucketStartMs);
  const remainingHours = Math.max(remainingMs / 3600000, DAILY_BURST_RATE_MIN_REMAINING_HOURS);
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

/**
 * The shortfall threshold this home is judged against, or `null` when Capacity
 * limit is off: with no capacity period in force there is no hard-cap breach to
 * project, so no threshold exists (genuine absence, not a missing read).
 *
 * The ONE owner of "is the capacity shortfall question asked at all". The plan
 * build (once per build, from the settings it read once), the silent-meter pass,
 * the rebuild throttle's reading, the periodic status log and the Flow alert
 * condition all take the threshold from here and treat `null` as "capacity
 * control is off"; none of them re-asks `capacityEnabled` beside it.
 */
export function resolveShortfallThresholdKw(
  settings: PowerLimitSettings,
  powerTracker: PowerTrackerState,
  nowMs: number,
): number | null {
  return settings.capacityEnabled ? computeShortfallThreshold(settings, powerTracker, nowMs) : null;
}

/** Recheck period alerts against this home's live settings and accepted meter sample. */
export function isCapacityShortfallAlertActive(
  guard: CapacityGuard,
  settings: PowerLimitSettings,
  tracker: PowerTrackerState,
): boolean {
  const thresholdKw = resolveShortfallThresholdKw(settings, tracker, Date.now());
  return thresholdKw !== null
    && guard.isShortfallAlertConditionActive(resolveLastTotalPowerKw(tracker), thresholdKw);
}
