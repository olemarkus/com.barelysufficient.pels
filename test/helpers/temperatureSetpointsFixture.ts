import {
  createTemperatureSetpointResolver,
  type TemperatureIntentReads,
} from '../../lib/thermostat/temperatureSetpoints';
import { PriceLevel } from '../../lib/price/priceLevels';
import type {
  ResolveTemperatureSetpoints,
  ResolvedShedBehavior,
  TemperatureSetpoints,
  TemperatureSetpointsByDevice,
} from '../../packages/planner-types/src/temperatureSetpoints';
import type { PlanInputDevice } from '../../packages/planner-types/src/planInputDevice';

/**
 * The real setpoint resolver over a spec's reads. A spec spells only the reads
 * it is about; the rest describe the ordinary case — no mode targets, no price
 * shift, a heater, no setpoint limit.
 */
export const fixtureTemperatureSetpoints = (
  reads: Partial<TemperatureIntentReads> = {},
): ResolveTemperatureSetpoints => createTemperatureSetpointResolver({
  getOperatingMode: () => 'Home',
  getModeDeviceTargets: () => ({}),
  getPriceOptimizationEnabled: () => false,
  getPriceOptimizationSettings: () => ({}),
  getCurrentHourPriceLevel: () => PriceLevel.UNKNOWN,
  shouldApplyPriceShift: () => true,
  hasPendingPriceShiftCancellations: () => false,
  getThermalDirection: () => 'heating',
  getShedBehavior: () => ({ action: 'turn_off' }),
  ...reads,
});

/** The same resolver, run over a spec's devices, for a stage the spec drives without the builder. */
export const resolveFixtureTemperatureSetpoints = (
  devices: readonly PlanInputDevice[],
  reads: Partial<TemperatureIntentReads> = {},
): TemperatureSetpointsByDevice => fixtureTemperatureSetpoints(reads)(devices);

/**
 * One device's setpoints, pinned rather than resolved, for a spec about how a
 * stage READS a fact. Defaults describe a heater kept at 21 °C with nothing
 * held back and no setpoint limit.
 */
export const fixtureTemperatureSetpointsEntry = (
  overrides: Partial<TemperatureSetpoints> = {},
): TemperatureSetpoints => ({
  intendedC: 21,
  desiredC: 21,
  keepC: 21,
  surplusC: 21,
  targetStepC: 0.5,
  shed: { action: 'turn_off' },
  keepAddsDemand: false,
  surplusAddsDemand: false,
  keepAsksLessThanIntended: false,
  surplusAsksLessThanIntended: false,
  targetShortOfDesired: false,
  roomShortOfIntended: false,
  ...overrides,
});

/** A setpoint limit at `limitC` that asks for less than the intended target. */
export const fixtureSetpointLimit = (limitC: number, releasesDemand: boolean): ResolvedShedBehavior => ({
  action: 'set_temperature',
  limitC,
  releasesDemand,
  asksLessThanIntended: true,
});

/**
 * Setpoints for devices limited by setpoint, pinned: each sits at its limit
 * (moving it there releases nothing) and its kept setpoint asks for more work,
 * so moving off the limit is a resume.
 */
export const fixtureLimitedSetpoints = (
  limits: Readonly<Record<string, number>>,
  overrides: Partial<TemperatureSetpoints> = {},
): TemperatureSetpointsByDevice => new Map(Object.entries(limits).map(([deviceId, limitC]) => [
  deviceId,
  fixtureTemperatureSetpointsEntry({ shed: fixtureSetpointLimit(limitC, false), keepAddsDemand: true, ...overrides }),
]));
