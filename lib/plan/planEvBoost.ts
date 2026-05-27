import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { getLogger } from '../logging/logger';
import { resolveBoostActive } from '../device/deviceActionProjection';

// `resolveEvBoostActive` moved to `lib/device/deviceActionProjection.ts`
// as chunk 1 of the planner-detype refactor. Re-exported here so every
// existing call site continues to work unchanged.
export { resolveEvBoostActive } from '../device/deviceActionProjection';

const logger = getLogger('plan/ev-boost');

export function emitEvBoostStateChange(params: {
  dev: PlanInputDevice;
  previousActive: boolean;
  active: boolean;
}): void {
  const { dev, previousActive, active } = params;
  if (previousActive === active) return;
  const boostBelowPercent = dev.evBoost?.boostBelowPercent;
  logger.debug({
    event: 'ev_boost_state_changed',
    deviceId: dev.id,
    deviceName: dev.name,
    active,
    previousActive,
    percent: typeof dev.stateOfCharge?.percent === 'number' ? dev.stateOfCharge.percent : null,
    boostBelowPercent: typeof boostBelowPercent === 'number' ? boostBelowPercent : null,
    status: dev.stateOfCharge?.status ?? null,
    evChargingState: dev.evChargingState ?? null,
    observationStale: dev.observationStale === true,
  });
}

export function buildBoostPlanDeviceFields(params: {
  dev: PlanInputDevice;
  temperatureBoostActive: boolean;
  evBoostActive: boolean;
}): Pick<
  DevicePlanDevice,
  | 'currentTemperature'
  | 'temperatureBoost'
  | 'temperatureBoostActive'
  | 'evBoost'
  | 'evBoostActive'
  | 'boostActive'
  | 'stateOfCharge'
> {
  const { dev, temperatureBoostActive, evBoostActive } = params;
  return {
    currentTemperature: dev.currentTemperature,
    temperatureBoost: dev.temperatureBoost,
    temperatureBoostActive,
    evBoost: dev.evBoost,
    evBoostActive,
    boostActive: resolveBoostActive({ temperatureBoostActive, evBoostActive }),
    stateOfCharge: dev.stateOfCharge,
  };
}
