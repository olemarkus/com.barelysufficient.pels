import type { Logger } from '../utils/types';
import type { LiveDevicePowerWatts } from './deviceManagerEnergy';
import type { DeviceCapabilityMap } from './deviceManagerControl';
import { updateLastKnownPower } from './deviceManagerRuntime';
import { readDeviceMeasuredPowerObservation } from './deviceMeasuredPowerReader';
import type { DeviceMeasuredPowerResolver } from './deviceMeasuredPowerResolver';
import type { PowerEstimateState } from './powerEstimate';

export function resolveMeasuredPowerKw(params: {
  deviceId: string;
  deviceLabel: string;
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  livePowerWByDeviceId: LiveDevicePowerWatts;
  now: number;
  measuredPowerResolver: DeviceMeasuredPowerResolver;
  powerState: Required<PowerEstimateState>;
  logger: Logger;
}): { measuredPowerKw?: number; observedAtMs?: number } {
  const {
    deviceId,
    deviceLabel,
    capabilities,
    capabilityObj,
    livePowerWByDeviceId,
    now,
    measuredPowerResolver,
    powerState,
    logger,
  } = params;
  const measuredPower = measuredPowerResolver.resolve({
    deviceId,
    deviceLabel,
    observation: readDeviceMeasuredPowerObservation({
      deviceId,
      capabilities,
      capabilityObj,
      livePowerWByDeviceId,
      homeyEnergyObservedAtMs: now,
    }),
  });
  if (typeof measuredPower.measuredPowerKw === 'number' && Number.isFinite(measuredPower.measuredPowerKw)) {
    updateLastKnownPower({
      state: powerState,
      logger,
      deviceId,
      measuredKw: measuredPower.measuredPowerKw,
      deviceLabel,
    });
  }
  return measuredPower;
}
