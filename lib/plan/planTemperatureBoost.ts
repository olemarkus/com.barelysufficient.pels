import type { PlanInputDevice } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { hasTemperatureBoostTarget } from '../utils/temperatureBoost';
import type { StructuredDebugEmitter } from '../logging/logger';
import {
  buildDeferredObjectiveDebugPayload,
  evaluateThermalStorageObjective,
} from '../core/deferredObjectives';

export const TEMPERATURE_BOOST_EXIT_MARGIN_C = 2;

export function supportsTemperatureBoostDevice(device: PlanInputDevice): boolean {
  return hasTemperatureBoostTarget(device.targets);
}

export function resolveTemperatureBoostActive(params: {
  dev: PlanInputDevice;
  previousActive: boolean;
}): boolean {
  const { dev, previousActive } = params;
  const config = dev.temperatureBoost;
  if (config?.enabled !== true) return false;
  if (!isSteppedLoadDevice(dev)) return false;
  if (!supportsTemperatureBoostDevice(dev)) return false;
  if (dev.controllable === false || dev.managed === false || dev.available === false) return false;
  if (dev.observationStale === true) return false;
  const currentTemperature = dev.currentTemperature;
  if (typeof currentTemperature !== 'number' || !Number.isFinite(currentTemperature)) return false;
  const boostBelowC = config.boostBelowC;
  if (typeof boostBelowC !== 'number' || !Number.isFinite(boostBelowC)) return false;
  const exitThresholdC = boostBelowC + TEMPERATURE_BOOST_EXIT_MARGIN_C;
  return previousActive
    ? currentTemperature < exitThresholdC
    : currentTemperature < boostBelowC;
}

export function emitTemperatureBoostStateChange(params: {
  dev: PlanInputDevice;
  previousActive: boolean;
  active: boolean;
  debugStructured?: StructuredDebugEmitter;
}): void {
  const { dev, previousActive, active, debugStructured } = params;
  if (!debugStructured || previousActive === active) return;
  const boostBelowC = dev.temperatureBoost?.boostBelowC;
  debugStructured({
    event: 'temperature_boost_state_changed',
    deviceId: dev.id,
    deviceName: dev.name,
    active,
    previousActive,
    currentTemperatureC: typeof dev.currentTemperature === 'number' ? dev.currentTemperature : null,
    boostBelowC: typeof boostBelowC === 'number' ? boostBelowC : null,
    exitThresholdC: typeof boostBelowC === 'number' ? boostBelowC + TEMPERATURE_BOOST_EXIT_MARGIN_C : null,
    observationStale: dev.observationStale === true,
  });
}

export function emitTemperatureBoostObjectiveEvaluation(params: {
  dev: PlanInputDevice;
  active: boolean;
  debugStructured?: StructuredDebugEmitter;
}): void {
  const { dev, active, debugStructured } = params;
  const config = dev.temperatureBoost;
  if (!debugStructured || config?.enabled !== true || !active) return;
  if (!isSteppedLoadDevice(dev) || !dev.steppedLoadProfile) return;
  const exitThresholdC = config.boostBelowC + TEMPERATURE_BOOST_EXIT_MARGIN_C;
  const evaluation = evaluateThermalStorageObjective({
    nowMs: Date.now(),
    profile: dev.steppedLoadProfile,
    measuredTemperatureC: dev.currentTemperature,
    measuredTemperatureObservedAtMs: dev.lastFreshDataMs,
    targetTemperatureC: exitThresholdC,
    rateConfidence: 'low',
  });
  debugStructured({
    ...buildDeferredObjectiveDebugPayload({
      deviceId: dev.id,
      deviceName: dev.name,
      evaluation,
    }),
    event: 'temperature_boost_objective_evaluated',
    boostActive: active,
    boostBelowC: config.boostBelowC,
    exitThresholdC,
  });
}
