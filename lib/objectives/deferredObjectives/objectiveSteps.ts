import { sortSteppedLoadSteps } from '../../utils/deviceControlProfiles';
import { isEvDevice } from '../../../packages/shared-domain/src/commandableNow';
import { isTemperatureControlDevice } from '../../../packages/shared-domain/src/temperatureDeviceKind';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { resolveStepDeliveryUsefulKw } from './objectiveStepPower';
import { drawWhenActivelyDrawingKw, firstPositiveFinite } from './planningSpeed';
import type { DeferredObjectiveStep } from './types';

const resolveAdmissionPowerKw = (
  device: ObjectiveDeviceInput,
  stepId: string,
  fallbackKw: number,
): number => {
  const calibrated = device.stepPowerCalibration?.[stepId]?.admissionPowerKw;
  return typeof calibrated === 'number' && Number.isFinite(calibrated) && calibrated > 0
    ? calibrated
    : fallbackKw;
};

// Resolves the per-objective step list the horizon planner consumes. Stepped
// devices expose their full ladder via `steppedLoadProfile`; EV chargers and
// thermal devices without stepped controls route through the same calibrated
// lookup so the allocator's per-step useful power agrees with the hero's
// planning-speed reading (otherwise a confident calibration below nameplate
// would let the allocator over-promise delivery while the hero shows a slower
// speed). Returns an empty list when the device has neither a stepped profile
// nor a usable planning/expected/measured power.
export const resolveObjectiveSteps = (device: ObjectiveDeviceInput): DeferredObjectiveStep[] => {
  const profile = device.steppedLoadProfile;
  if (profile) {
    return sortSteppedLoadSteps(profile.steps).map((step) => {
      const nameplateKw = step.planningPowerW / 1000;
      return {
        id: step.id,
        usefulPowerKw: resolveStepDeliveryUsefulKw(device, step.id, nameplateKw),
        admissionPowerKw: resolveAdmissionPowerKw(device, step.id, nameplateKw),
      };
    });
  }
  const planning = device.planningPowerKw;
  if (typeof planning === 'number' && Number.isFinite(planning) && planning > 0) {
    return [{
      id: 'charge',
      usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', planning),
      admissionPowerKw: resolveAdmissionPowerKw(device, 'charge', planning),
    }];
  }
  if (isEvDevice(device)) {
    const expected = firstPositiveFinite([device.expectedPowerKw, device.powerKw]);
    if (expected !== null) {
      return [{
        id: 'charge',
        usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', expected),
        admissionPowerKw: resolveAdmissionPowerKw(device, 'charge', expected),
      }];
    }
  }
  // Thermal-without-stepped-controls fallback: emit one synthetic "charge"
  // step from measured/expected/nameplate power so the bucket allocator can
  // build a horizon plan instead of leaving the smart task stuck on
  // `objective_missing_charge_rate` / `pendingReason: missing_capacity`.
  // The live draw (`currentDrawKw`) is preferred — on a heating cycle it is the
  // most accurate nameplate we have for these devices; `drawWhenActivelyDrawingKw`
  // ignores a standby trickle, so an idle heater falls through to
  // `expectedPowerKw` / `powerKw` (which the power estimator populates from
  // the load setting / Homey Energy approximation). EV chargers do not use
  // the live draw here because their `expectedPowerKw` is the calibrated
  // 1-step view from `appInit/calibrationViews.buildEvChargerCalibrationView` and the
  // existing branch above is the documented invariant for EV planning speed.
  // Mill-/Adax-/Glamox-shaped Norwegian panel heaters report class
  // `thermostat`, `onoff` + `target_temperature` + `measure_power`, no
  // stepped controls; before this branch they kept `pendingReason:
  // missing_capacity` indefinitely even with a converged learned profile.
  if (isTemperatureControlDevice(device)) {
    const expected = firstPositiveFinite([
      drawWhenActivelyDrawingKw(device.currentDrawKw),
      device.expectedPowerKw,
      device.powerKw,
    ]);
    if (expected !== null) {
      return [{
        id: 'charge',
        usefulPowerKw: resolveStepDeliveryUsefulKw(device, 'charge', expected),
        admissionPowerKw: resolveAdmissionPowerKw(device, 'charge', expected),
      }];
    }
  }
  return [];
};
