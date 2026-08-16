import type { PlanInputDevice } from './planTypes';
import { getLogger } from '../logging/logger';

/**
 * The planner's whole boost vocabulary: one question, one answer, no device
 * kinds. The producer (`resolveBoostSupported` / `resolveBoostRequested` in
 * `lib/device/deviceActionProjection.ts`) has already asked whether PELS can
 * drive a boost on this device and whether its own policy wants one right now;
 * the planner adds the three things only it knows.
 *
 * 1. The runnable gate. `controllable` in particular is not the producer's
 *    answer to keep: deferred-objective admission can flip it to `true` for a
 *    rescued cap-off device AFTER `toPlanDevice` ran, and that device must be
 *    able to boost.
 * 2. The release. A boost is a claim on other devices' power — it escalates a
 *    ladder past the fairness invariant and lets a swap pause a running
 *    lower-priority device. A device that is confidently drawing nothing cannot
 *    spend what it claims, so the claim is released. This is where the whole
 *    "is it actually using the power" question lives, for every kind of device
 *    and every consumer of the decision: a boosted water heater holding at its
 *    element setpoint and a boosted charger whose car has stopped accepting
 *    charge are the same situation, and neither should keep a neighbour paused.
 *    It releases a FORCED boost too — the rescue lane's claim buys the smart
 *    task nothing on a device that is not drawing either.
 * 3. The forced request. The limit-lower-priority rescue lane sets
 *    `forceBoostActive` to engage boost independently of the device's own
 *    threshold — but only where boost is supported, so a device PELS cannot
 *    drive is never forced into one.
 *
 * The release is deliberately not a hysteresis band on the floor comparison:
 * evidence that the device is idle is a stronger and more honest signal than a
 * margin above a threshold, and it is the one signal both axes share.
 */
export function resolveBoostActive(dev: PlanInputDevice): boolean {
  if (dev.controllable === false || dev.managed === false || dev.available === false) return false;
  if (dev.confirmedNotDrawing) return false;
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
    confirmedNotDrawing: dev.confirmedNotDrawing,
  });
}
