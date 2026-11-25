import type {
  CapacityScalarSettings,
  HardCapSource,
  PowerLimitSettings,
} from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from './trackerTypes';
import { resolveCurrentMonthCapacityPeak, type CapacityMonthPeak } from './capacityPeak';
import type { MeterMonthlyPeak } from './meterMonthlyPeak';
import { nextCapacityMonthStartMs } from './capacityQuarterTracking';
import { resolvePlanningCeilingKw } from './capacityModel';
import { capacityLimitKwAt } from '../../packages/shared-domain/src/settings/powerLimits';

export type { HardCapSource } from '../../packages/contracts/src/capacitySettings';

/**
 * The power limits live control holds: the control settings with `limitKw` as
 * the held hard cap, which hard cap it is, and the configured one beside it.
 * The margin, the period, Capacity limit and the grid import limit are always
 * the configured ones.
 *
 * Only live control reads these (the plan builder, the capacity guard, the
 * power sample throttle and the plan's meta). Smart-task and battery horizons
 * use a dated override through month-end. Daily budget, budget prices, weather,
 * and the hourly budget the tracker records use the configured cap.
 */
export type HeldPowerLimitSettings = PowerLimitSettings & {
  hardCapSource: HardCapSource;
  configuredLimitKw: number;
};

const canFollowMonthPeak = (settings: CapacityScalarSettings): boolean => (
  settings.followMonthPeak && settings.capacityEnabled && settings.periodMinutes === 15
);

/**
 * Hold the hard cap at this month's peak once it is higher than the configured
 * one: a tariff that bills the month's highest quarter has already been charged
 * for that peak, so holding the house below it saves nothing. Only with the
 * owner's switch on, the 15-minute period and Capacity limit on; otherwise, and
 * while the month has no completed quarter, the configured settings stand.
 */
export function resolveHeldPowerLimits(
  scalars: CapacityScalarSettings,
  peak: CapacityMonthPeak,
): HeldPowerLimitSettings {
  const { dryRun: _dryRun, followMonthPeak: _followMonthPeak, ...settings } = scalars;
  const follows = canFollowMonthPeak(scalars) && peak.state === 'recorded' && peak.peakKw > settings.limitKw;
  return follows
    ? { ...settings, limitKw: peak.peakKw, hardCapSource: 'month_peak', configuredLimitKw: settings.limitKw }
    : { ...settings, hardCapSource: 'configured', configuredLimitKw: settings.limitKw };
}

/**
 * The configured settings behind held limits: what the tracker records the
 * hourly budget against, whatever cap live control holds.
 */
export const configuredPowerLimits = (held: HeldPowerLimitSettings): PowerLimitSettings => {
  const { hardCapSource: _hardCapSource, configuredLimitKw, ...settings } = held;
  return { ...settings, limitKw: configuredLimitKw };
};

/** Configured limits with a higher hard cap available until the local month ends. */
export type ScheduledPowerLimits = PowerLimitSettings & {
  monthPeak?: { limitKw: number; endsAtMs: number };
};

export function resolveScheduledPowerLimits(
  scalars: CapacityScalarSettings,
  readMonthPeak: (nowMs: number) => CapacityMonthPeak,
  timeZone: string,
  nowMs: number,
): ScheduledPowerLimits {
  const { dryRun: _dryRun, followMonthPeak: _followMonthPeak, ...configured } = scalars;
  if (!canFollowMonthPeak(scalars)) return configured;
  const held = resolveHeldPowerLimits(scalars, readMonthPeak(nowMs));
  if (held.hardCapSource === 'configured') return configured;
  return {
    ...configured,
    monthPeak: { limitKw: held.limitKw, endsAtMs: nextCapacityMonthStartMs(nowMs, timeZone) },
  };
}

export function powerLimitsAt(
  limits: ScheduledPowerLimits,
  atMs: number,
): Omit<PowerLimitSettings, 'monthlyCapacityChoice'> {
  const { monthPeak, monthlyCapacityChoice, ...settings } = limits;
  // An explicit monthly capacity choice (hourly periods only) and a held month peak (15-minute only) never coincide.
  if (monthlyCapacityChoice) return { ...settings, limitKw: capacityLimitKwAt(limits, atMs) };
  return monthPeak && atMs < monthPeak.endsAtMs ? { ...settings, limitKw: monthPeak.limitKw } : settings;
}

/** A ceiling read with the boundary that can split a price interval. */
export function planningCeilingSchedule(limits: ScheduledPowerLimits): {
  changesAtMs: number | null;
  at: (atMs: number) => number | null;
} {
  const { monthPeak, monthlyCapacityChoice: choice } = limits;
  if (choice) {
    return { changesAtMs: choice.endsAtMs, at: (atMs) => resolvePlanningCeilingKw(powerLimitsAt(limits, atMs)) };
  }
  const configuredKw = resolvePlanningCeilingKw(limits);
  if (!monthPeak) return { changesAtMs: null, at: () => configuredKw };
  const heldKw = resolvePlanningCeilingKw({ ...limits, limitKw: monthPeak.limitKw });
  if (heldKw === configuredKw) return { changesAtMs: null, at: () => configuredKw };
  return {
    changesAtMs: monthPeak.endsAtMs,
    at: (atMs) => atMs < monthPeak.endsAtMs ? heldKw : configuredKw,
  };
}

/**
 * One home's reads behind its held limits: its resolved scalars, its tracker,
 * its meter's own month peak and the time zone.
 */
export type HeldCapacityLimitPorts = {
  readScalars: () => CapacityScalarSettings;
  readTracker: () => PowerTrackerState;
  readMeterPeak: () => MeterMonthlyPeak | null;
  readTimeZone: () => string;
};

/**
 * The held limits as a live read: every call resolves the home's current
 * scalars against this month's peak at that moment, so a quarter that has just
 * completed (or a month that has just rolled over) is in the next read.
 */
export const createHeldCapacityLimitRead = (ports: HeldCapacityLimitPorts): () => HeldPowerLimitSettings => (
  () => resolveHeldPowerLimits(
    ports.readScalars(),
    resolveCurrentMonthCapacityPeak(ports.readTracker(), ports.readMeterPeak(), ports.readTimeZone(), Date.now()),
  )
);
