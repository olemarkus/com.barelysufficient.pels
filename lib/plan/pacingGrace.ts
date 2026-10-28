import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import { isOverShortfallThreshold } from '../power/capacityGuard';
import { resolveCapacityMarginKWh } from '../power/capacityModel';
import type { LatchedMeterReading } from '../power/lastTotalPower';
import { isInEndOfHourDrain } from './planBudget';
import { SHED_GRACE_MARGIN_FRACTION, SHED_GRACE_MAX_MS } from './planConstants';
import type { MeasuredPower, PlanContext } from './planContext';
import { isMeteredPlanDevice } from './planMeteredDevice';
import { resolveSoftOvershootDecision, type SoftOvershootDecision } from './planOvershoot';
import type { StorageShedTerm } from './shedding/types';

const HOUR_MS = 3_600_000;
const ENERGY_EPSILON_KWH = 1e-12;

type GracePeriod = {
  startMs: number;
  durationMs: number;
  /** First observed partial period is unavailable, including after a restart. */
  available: boolean;
  spentKWh: number;
};

type GraceObservation = {
  reading: LatchedMeterReading;
  priceKw: number;
  /** Sticky until the next reading settles this interval, even after a rebuild acts. */
  waited: boolean;
  canRepeatWait: boolean;
};

/**
 * Half the configured period margin funds discretionary patience on observed,
 * estimated avoided reductions; the other half remains response reserve.
 * This is an operational allowance, not measured savings or a bound on unseen
 * power changes. Every wait must fund a whole observed sample interval. A late
 * reading settles its full interval and can overdraw the allowance; it cannot
 * buy another wait. Meter outages retain the power owner's fail-closed policy.
 */
export class PacingGrace {
  private period: GracePeriod | null = null;

  private observation: GraceObservation | null = null;

  private cadenceMs: number | null = null;

  private pendingSinceMs: number | null = null;

  private episodeActed = false;

  decide(
    context: PlanContext,
    power: MeasuredPower,
    settings: PowerLimitSettings,
    storage: StorageShedTerm,
    shortfallThresholdKw: number | null,
    reading: LatchedMeterReading,
  ): SoftOvershootDecision {
    const priceKw = resolveGracePriceKw(context, power);
    const previous = this.observation;
    const observation = this.observe(settings, reading, priceKw);
    const fresh = observation !== previous;
    // Settle the previous waiting interval before every clear or urgent exit.
    if (power.gridBreached) return this.finishImmediate(true, observation);
    if (power.headroomKw === null) return this.finishImmediate(false, observation);
    const headroomKw = power.headroomKw + storage.netCreditKw;
    if (headroomKw >= 0) return this.finishImmediate(false, observation);
    const urgent = shortfallThresholdKw !== null && isOverShortfallThreshold(power.drawKw, shortfallThresholdKw);
    // A known battery hand-back is an incoming load step, not a background
    // transient whose unchanged measured draw can price a discretionary wait.
    const graceAllowed = storage.netCreditKw >= 0 && !urgent && !this.episodeActed
      && (fresh || observation.canRepeatWait)
      && this.canFundWait(context, power, settings, priceKw, shortfallThresholdKw);
    const decision = resolveSoftOvershootDecision(headroomKw, graceAllowed, this.pendingSinceMs, context.nowTs);
    this.pendingSinceMs = decision.pendingSinceMs;
    this.episodeActed ||= decision.shedActionable;
    observation.waited ||= graceAllowed && decision.actionable && !decision.shedActionable;
    observation.canRepeatWait = graceAllowed && !decision.shedActionable;
    return decision;
  }

  private finishImmediate(actionable: boolean, observation: GraceObservation): SoftOvershootDecision {
    this.pendingSinceMs = null;
    this.episodeActed = false;
    Object.assign(observation, { canRepeatWait: false });
    return { actionable, shedActionable: actionable, pendingSinceMs: null };
  }

  private observe(settings: PowerLimitSettings, reading: LatchedMeterReading, priceKw: number): GraceObservation {
    const previous = this.observation;
    if (previous !== null && reading.atMs <= previous.reading.atMs) {
      // Device observations can change a price, but cannot refresh the meter or allowance.
      previous.priceKw = Math.max(previous.priceKw, priceKw);
      // Tracker sampling can restart after a wall-clock regression. It cannot
      // extend an older funded wait until the clock catches up.
      if (reading.atMs < previous.reading.atMs) {
        previous.canRepeatWait = false;
        if (this.period !== null) this.period.available = false;
      }
      return previous;
    }
    const durationMs = settings.periodMinutes * 60_000;
    const startMs = Math.floor(reading.atMs / durationMs) * durationMs;
    const chargedKw = previous === null ? 0 : Math.max(previous.priceKw, priceKw);
    if (previous !== null) this.cadenceMs = reading.atMs - previous.reading.atMs;
    let period = this.period;
    if (period === null) {
      period = { startMs, durationMs, available: false, spentKWh: 0 };
    } else if (period.startMs !== startMs || period.durationMs !== durationMs) {
      const sameTariffPeriod = period.durationMs === durationMs;
      period = {
        startMs,
        durationMs,
        available: sameTariffPeriod && startMs > period.startMs,
        spentKWh: sameTariffPeriod ? 0 : period.spentKWh,
      };
    }
    if (previous?.waited) {
      const sinceMs = Math.max(previous.reading.atMs, period.startMs);
      period.spentKWh += chargedKw * (reading.atMs - sinceMs) / HOUR_MS;
    }
    this.period = period;
    this.observation = { reading, priceKw, waited: false, canRepeatWait: false };
    return this.observation;
  }

  private canFundWait(
    context: PlanContext,
    power: MeasuredPower,
    settings: PowerLimitSettings,
    priceKw: number,
    shortfallThresholdKw: number | null,
  ): boolean {
    // With capacity disabled this only defers soft daily pacing. Grid pressure
    // already took the immediate branch; no capacity cushion is being spent.
    if (shortfallThresholdKw === null) return true;
    const { period, cadenceMs } = this;
    if (period === null || !period.available || cadenceMs === null || cadenceMs > SHED_GRACE_MAX_MS) return false;
    if (period.durationMs !== settings.periodMinutes * 60_000) return false;
    if (Math.floor(context.nowTs / period.durationMs) * period.durationMs !== period.startMs) return false;
    if (!context.capacityPeriodCoverageComplete || context.usedKWh >= context.budgetKWh) return false;
    if (isInEndOfHourDrain(settings.periodMinutes, context.minutesRemaining)) return false;
    if (context.minutesRemaining * 60_000 <= Math.max(SHED_GRACE_MAX_MS, cadenceMs)) return false;
    const marginKWh = resolveCapacityMarginKWh(settings);
    const allowanceKWh = marginKWh * SHED_GRACE_MARGIN_FRACTION;
    const responseReserveKWh = marginKWh - allowanceKWh;
    const nextIntervalKWh = priceKw * cadenceMs / HOUR_MS;
    // The measured trajectory may already occupy some of the cushion. Do not
    // spend those watt-hours again merely because its projection is still below the cap.
    const projectionSpareKWh = Math.max(0, shortfallThresholdKw - power.drawKw) * context.minutesRemaining / 60;
    return allowanceKWh > 0
      && period.spentKWh + nextIntervalKWh <= allowanceKWh + ENERGY_EPSILON_KWH
      && nextIntervalKWh + responseReserveKWh <= projectionSpareKWh + ENERGY_EPSILON_KWH;
  }
}
/** A cut cannot avoid more observed import than the controllable devices draw. */
function resolveGracePriceKw(context: PlanContext, power: MeasuredPower): number {
  const managedKw = context.devices.reduce((sum, device) => (
    sum + (device.control.commandAuthority && isMeteredPlanDevice(device) ? Math.max(0, device.currentDrawKw) : 0)
  ), 0);
  return Math.min(Math.max(0, power.drawKw), managedKw);
}
