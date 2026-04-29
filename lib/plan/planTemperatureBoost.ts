import type { PlanInputDevice } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { hasTemperatureBoostTarget } from '../../packages/contracts/src/temperatureBoost';

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
