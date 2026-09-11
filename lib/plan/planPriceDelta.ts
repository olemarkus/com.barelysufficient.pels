/**
 * The price-based temperature shift: the owner's cheap-hour and expensive-hour
 * setpoint deltas, applied in the direction the device actually moves demand.
 *
 * Both surfaces that collect the pair label it as effort, not sign — a
 * "Cheap-hour boost" and an "Expensive-hour reduction" — so effort is what this
 * applies. A cheap hour moves the setpoint the way that makes the device work
 * HARDER, an expensive hour the way that lets it coast, and which way that is
 * depends on the device: up then down for a heater, down then up for a unit
 * that is cooling.
 *
 * The MAGNITUDE is what the configured numbers contribute, deliberately, rather
 * than their stored sign. The stored convention is heating-shaped (`cheapDelta`
 * positive, `expensiveDelta` negative) and the Prices tab enforces it
 * (`DELTA_MIN = 0`), but the device-detail editor's cheap field accepts -20..20
 * and the persisted-settings boundary gates only finiteness — so a negative
 * `cheapDelta` is reachable, and an owner who hand-worked-around the old
 * inversion on an air conditioner is exactly who would hold one. Reading the
 * sign would turn their cheap-hour boost into a cheap-hour coast and run the
 * compressor flat out through the expensive hour. Reading the magnitude gives
 * every stored pair the behaviour both labels promise.
 *
 * One implementation, shared by the planner's target resolution and the
 * diagnostics projection of "what this device is being asked for", because two
 * copies of a rule with a sign in it is two chances to disagree — and if the
 * diagnostics copy did not flip, the owner would read a target PELS never wrote.
 */
import { PriceLevel } from '../price/priceLevels';
import type { ThermalDirection } from '../../packages/contracts/src/types';
import type { PriceOptDeviceConfig } from './planSurplusAbsorb';

export function applyPriceOptimizationDelta(
  target: number,
  config: PriceOptDeviceConfig,
  priceLevel: PriceLevel,
  direction: ThermalDirection,
): number {
  const shift = resolvePriceShiftMagnitude(config, priceLevel);
  if (shift === 0) return target;
  const worksHarder = priceLevel === PriceLevel.CHEAP;
  const raises = worksHarder === (direction === 'heating');
  return raises ? target + shift : target - shift;
}

/** How far the setpoint moves this hour, as a distance. Direction is decided above. */
function resolvePriceShiftMagnitude(config: PriceOptDeviceConfig, priceLevel: PriceLevel): number {
  if (priceLevel === PriceLevel.CHEAP) return Math.abs(config.cheapDelta);
  if (priceLevel === PriceLevel.EXPENSIVE) return Math.abs(config.expensiveDelta);
  return 0;
}
