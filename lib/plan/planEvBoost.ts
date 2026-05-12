import type { DevicePlanDevice, PlanInputDevice } from './planTypes';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { getTrustedStateOfCharge } from '../observer/observationTrust';
import type { StructuredDebugEmitter } from '../logging/logger';

export function resolveEvBoostActive(params: {
  dev: PlanInputDevice;
  previousActive: boolean;
}): boolean {
  const { dev } = params;
  const config = dev.evBoost;
  if (config?.enabled !== true) return false;
  if (dev.deviceClass !== 'evcharger') return false;
  if (!isSteppedLoadDevice(dev)) return false;
  if (dev.controllable === false || dev.managed === false || dev.available === false) return false;
  if (dev.evChargingState === 'plugged_out' || dev.evChargingState === 'plugged_in_discharging') return false;
  const stateOfCharge = getTrustedStateOfCharge(dev);
  if (!stateOfCharge) return false;
  const boostBelowPercent = config.boostBelowPercent;
  if (!Number.isFinite(boostBelowPercent)) return false;
  return stateOfCharge.percent < boostBelowPercent;
}

export function emitEvBoostStateChange(params: {
  dev: PlanInputDevice;
  previousActive: boolean;
  active: boolean;
  debugStructured?: StructuredDebugEmitter;
}): void {
  const { dev, previousActive, active, debugStructured } = params;
  if (!debugStructured || previousActive === active) return;
  const boostBelowPercent = dev.evBoost?.boostBelowPercent;
  debugStructured({
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
  'currentTemperature' | 'temperatureBoost' | 'temperatureBoostActive' | 'evBoost' | 'evBoostActive' | 'stateOfCharge'
> {
  const { dev, temperatureBoostActive, evBoostActive } = params;
  return {
    currentTemperature: dev.currentTemperature,
    temperatureBoost: dev.temperatureBoost,
    temperatureBoostActive,
    evBoost: dev.evBoost,
    evBoostActive,
    stateOfCharge: dev.stateOfCharge,
  };
}
