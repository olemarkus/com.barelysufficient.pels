import type { PlanInputDevice } from './planTypes';
import { getLogger } from '../logging/logger';

/**
 * The planner's whole boost vocabulary: one question, one answer, no device
 * kinds. The producer (`resolveBoostSupported` / `resolveBoostRequested` in
 * `lib/device/deviceActionProjection.ts`) has already asked whether this device
 * has a drivable boost axis and whether its own policy wants boost right now;
 * the planner adds the two things only it knows.
 *
 * 1. The runnable gate. `controllable` in particular is not the producer's
 *    answer to keep: deferred-objective admission can flip it to `true` for a
 *    rescued cap-off device AFTER `toPlanDevice` ran, and that device must be
 *    able to boost.
 * 2. The forced request. The limit-lower-priority rescue lane sets
 *    `forceBoostActive` to engage boost independently of the device's own
 *    threshold — but only where boost is supported, so a charger PELS cannot
 *    resume is never forced into one.
 *
 * Equivalent by construction to the two per-axis resolvers this replaced:
 * `runnable && ((evGates && (force || evFloor)) || (tempGates && (force ||
 * tempFloor)))` factors into exactly the expression below, because
 * `boostRequested` is each axis's floor already qualified by that axis's gates.
 */
export function resolveBoostActive(dev: PlanInputDevice): boolean {
  if (dev.controllable === false || dev.managed === false || dev.available === false) return false;
  if (dev.boostRequested) return true;
  return dev.forceBoostActive === true && dev.boostSupported;
}

const logger = getLogger('plan/boost');

/**
 * One transition event for every device that boosts, whatever it boosts on.
 * The unit-bearing detail the two former events carried (`percent` /
 * `boostBelowPercent`, `currentTemperatureC` / `boostBelowC`) is deliberately
 * absent: the planner no longer holds those values, and reaching back for them
 * would re-import the fork this replaced. They belong to the producer that
 * resolves the floor comparison.
 */
export function emitBoostStateChange(params: {
  dev: PlanInputDevice;
  previousActive: boolean;
  active: boolean;
}): void {
  const { dev, previousActive, active } = params;
  if (previousActive === active) return;
  logger.debug({
    event: 'boost_state_changed',
    deviceId: dev.id,
    deviceName: dev.name,
    active,
    previousActive,
    boostSupported: dev.boostSupported,
    boostRequested: dev.boostRequested,
    forced: dev.forceBoostActive === true,
  });
}
