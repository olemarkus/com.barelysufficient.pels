import { sortSteppedLoadSteps } from '../../utils/deviceControlProfiles';
import type { PlanInputDevice } from '../planTypes';
import { resolveStepDeliveryUsefulKw } from './objectiveStepPower';
import { firstPositiveFinite } from './planningSpeed';
import type { DeferredObjectiveStep } from './types';

// Resolves the per-objective step list the horizon planner consumes. Stepped
// devices expose their full ladder via `steppedLoadProfile`; EV chargers and
// thermal devices without stepped controls route through the same calibrated
// lookup so the allocator's per-step useful power agrees with the hero's
// planning-speed reading (otherwise a confident calibration below nameplate
// would let the allocator over-promise delivery while the hero shows a slower
// speed). Returns an empty list when the device has neither a stepped profile
// nor a usable planning/expected/measured power.
export const resolveObjectiveSteps = (device: PlanInputDevice): DeferredObjectiveStep[] => {
  const profile = device.steppedLoadProfile;
  if (profile) {
    return sortSteppedLoadSteps(profile.steps).map((step) => ({
      id: step.id,
      usefulPowerKw: resolveStepDeliveryUsefulKw(device, step.id, step.planningPowerW / 1000),
    }));
  }
  const planning = device.planningPowerKw;
  if (typeof planning === 'number' && Number.isFinite(planning) && planning > 0) {
    return [{ id: 'charge', usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', planning) }];
  }
  if (device.deviceClass === 'evcharger') {
    const expected = firstPositiveFinite([device.expectedPowerKw, device.powerKw]);
    if (expected !== null) {
      return [{ id: 'charge', usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', expected) }];
    }
  }
  // Thermal-without-stepped-controls fallback: emit one synthetic "charge"
  // step from measured/expected/nameplate power so the bucket allocator can
  // build a horizon plan instead of leaving the smart task stuck on
  // `objective_missing_charge_rate` / `pendingReason: missing_capacity`.
  // `measuredPowerKw` is preferred (live draw on a heating cycle is the most
  // accurate nameplate we have for these devices); `firstPositiveFinite`
  // skips 0/negative readings, so an idle heater falls through to
  // `expectedPowerKw` / `powerKw` (which the power estimator populates from
  // the load setting / Homey Energy approximation). EV chargers do not use
  // `measuredPowerKw` here because their `expectedPowerKw` is the calibrated
  // 1-step view from `appInit.buildEvChargerCalibrationView` and the
  // existing branch above is the documented invariant for EV planning speed.
  // Mill-/Adax-/Glamox-shaped Norwegian panel heaters report class
  // `thermostat`, `onoff` + `target_temperature` + `measure_power`, no
  // stepped controls; before this branch they kept `pendingReason:
  // missing_capacity` indefinitely even with a converged learned profile.
  if (device.deviceType === 'temperature') {
    const expected = firstPositiveFinite([device.measuredPowerKw, device.expectedPowerKw, device.powerKw]);
    if (expected !== null) {
      return [{ id: 'charge', usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', expected) }];
    }
  }
  return [];
};
