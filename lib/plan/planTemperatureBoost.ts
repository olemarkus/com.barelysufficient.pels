import type { PlanInputDevice } from './planTypes';
import { isTemperaturePlanDevice } from './planTemperatureDevice';
import { hasTemperatureBoostTarget } from '../utils/temperatureBoost';
import { getLogger } from '../logging/logger';

// `resolveTemperatureBoostActive` moved to
// `lib/device/deviceActionProjection.ts` as chunk 1 of the planner-detype
// refactor. Re-exported here so every existing call site continues to work
// unchanged.
export { resolveTemperatureBoostActive } from '../device/deviceActionProjection';

const logger = getLogger('plan/temperature-boost');

export function supportsTemperatureBoostDevice(device: PlanInputDevice): boolean {
  return hasTemperatureBoostTarget(device.targets);
}

export function emitTemperatureBoostStateChange(params: {
  dev: PlanInputDevice;
  previousActive: boolean;
  active: boolean;
}): void {
  const { dev, previousActive, active } = params;
  if (previousActive === active) return;
  const boostBelowC = dev.temperatureBoost?.boostBelowC;
  const currentTemperature = isTemperaturePlanDevice(dev) ? dev.currentTemperature : undefined;
  logger.debug({
    event: 'temperature_boost_state_changed',
    deviceId: dev.id,
    deviceName: dev.name,
    active,
    previousActive,
    currentTemperatureC: typeof currentTemperature === 'number' ? currentTemperature : null,
    boostBelowC: typeof boostBelowC === 'number' ? boostBelowC : null,
    observationStale: dev.observationStale === true,
  });
}
