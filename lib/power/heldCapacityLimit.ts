import type {
  CapacityScalarSettings,
  HardCapSource,
  PowerLimitSettings,
} from '../../packages/contracts/src/capacitySettings';
import type { PowerTrackerState } from './trackerTypes';
import { resolveCurrentMonthCapacityPeak, type CapacityMonthPeak } from './capacityPeak';

export type { HardCapSource } from '../../packages/contracts/src/capacitySettings';

/**
 * The power limits live control holds: the control settings with `limitKw` as
 * the held hard cap, which hard cap it is, and the configured one beside it.
 * The margin, the period, Capacity limit and the grid import limit are always
 * the configured ones.
 *
 * Only live control reads these (the plan builder, the capacity guard, the
 * power sample throttle and the plan's meta). Forward planning (daily budget,
 * smart tasks, budget price, the battery horizon, weather) and the hourly
 * budget the tracker records keep the configured hard cap.
 */
export type HeldPowerLimitSettings = PowerLimitSettings & {
  hardCapSource: HardCapSource;
  configuredLimitKw: number;
};

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
  const { dryRun: _dryRun, followMonthPeak, ...settings } = scalars;
  const follows = followMonthPeak && settings.periodMinutes === 15 && settings.capacityEnabled
    && peak.state === 'recorded' && peak.peakKw > settings.limitKw;
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

/** One home's reads behind its held limits: its resolved scalars, its tracker and the time zone. */
export type HeldCapacityLimitPorts = {
  readScalars: () => CapacityScalarSettings;
  readTracker: () => PowerTrackerState;
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
    resolveCurrentMonthCapacityPeak(ports.readTracker(), ports.readTimeZone(), Date.now()),
  )
);
