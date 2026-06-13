import type { DevicePlanDevice } from '../planTypes';
import { isFiniteNumber } from '../../utils/appTypeGuards';

/**
 * Observed instantaneous draw (kW) for restore-gap accounting.
 *
 * `measuredPowerKw` absence is the legitimate common case — most managed devices
 * don't meter power — so this resolves a present reading to a clamped
 * non-negative kW and treats absence (or, defensively, any non-finite value) as
 * "0 observed draw". It replaces the scattered NaN-blind `?? 0` reads with one
 * named, typed absence-handler, matching the house pattern in
 * `planSteppedLoad`/`deviceResidualKw`. After the boundary-finiteness sweep a
 * present `measuredPowerKw` is always finite, so the `isFiniteNumber` rung is the
 * absent-field default — not a live NaN guard — but it keeps the contract
 * explicit at the read.
 */
export function resolveObservedDrawKw(
  dev: Pick<DevicePlanDevice, 'measuredPowerKw'>,
): number {
  return isFiniteNumber(dev.measuredPowerKw) ? Math.max(0, dev.measuredPowerKw) : 0;
}

/**
 * Like {@link resolveObservedDrawKw} but with the configured nameplate `powerKw`
 * as a second rung when there is no measured reading — the binary
 * pending-restore-confirmation math falls back to the estimate before defaulting
 * to zero. The old `measuredPowerKw ?? powerKw ?? 0` was NaN-blind: `??` only
 * substitutes on `null`/`undefined`, so a non-finite `powerKw` would propagate;
 * the finite checks here drop it instead.
 */
export function resolveObservedDrawKwWithNameplate(
  dev: Pick<DevicePlanDevice, 'measuredPowerKw' | 'powerKw'>,
): number {
  if (isFiniteNumber(dev.measuredPowerKw)) return Math.max(0, dev.measuredPowerKw);
  if (isFiniteNumber(dev.powerKw)) return Math.max(0, dev.powerKw);
  return 0;
}
