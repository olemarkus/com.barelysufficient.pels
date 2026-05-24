import type { PlanInputDevice } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { hasTemperatureBoostTarget } from '../utils/temperatureBoost';
import { getTrustedCurrentTemperatureC } from '../observer/observationTrust';
import { getLogger } from '../logging/logger';

const logger = getLogger('plan/temperature-boost');

export const TEMPERATURE_BOOST_EXIT_MARGIN_C = 2;

export function supportsTemperatureBoostDevice(device: PlanInputDevice): boolean {
  return hasTemperatureBoostTarget(device.targets);
}

export function resolveTemperatureBoostActive(params: {
  dev: PlanInputDevice;
  previousActive: boolean;
}): boolean {
  const { dev, previousActive } = params;
  if (!isSteppedLoadDevice(dev)) return false;
  if (!supportsTemperatureBoostDevice(dev)) return false;
  if (dev.controllable === false || dev.managed === false || dev.available === false) return false;
  // The deferred limit-lower-priority rescue lane forces boost while the task is in its
  // planned hours, independent of the device's own boost config/threshold.
  if (dev.forceBoostActive === true) return true;
  const config = dev.temperatureBoost;
  if (config?.enabled !== true) return false;
  const currentTemperature = getTrustedCurrentTemperatureC(dev);
  if (currentTemperature === undefined) return false;
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
}): void {
  const { dev, previousActive, active } = params;
  if (previousActive === active) return;
  const boostBelowC = dev.temperatureBoost?.boostBelowC;
  logger.debug({
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
