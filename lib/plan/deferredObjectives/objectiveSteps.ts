import { sortSteppedLoadSteps } from '../../utils/deviceControlProfiles';
import type { PlanInputDevice } from '../planTypes';
import { resolveStepDeliveryUsefulKw } from './objectiveStepPower';
import { firstPositiveFinite } from './planningSpeed';
import type { DeferredObjectiveStep } from './types';

// Resolves the per-objective step list the horizon planner consumes. Stepped
// devices expose their full ladder via `steppedLoadProfile`; EV chargers route
// through the same calibrated lookup so the allocator's per-step useful power
// agrees with the hero's planning-speed reading (otherwise a confident
// calibration below nameplate would let the allocator over-promise delivery
// while the hero shows a slower speed). Returns an empty list when the device
// has neither a stepped profile nor a usable planning/expected power.
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
  return [];
};
