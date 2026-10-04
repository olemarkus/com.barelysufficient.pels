import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { estimatePower } from '../devicePowerEstimate';
import { resolveMeasuredPowerKw } from '../managerMeasuredPower';
import type { DeviceMeasuredPowerResolver } from '../measuredPowerResolver';
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceCapabilityMap } from '../managerControl';
import { getCurrentTemperature } from './managerParse';
import type { LiveDevicePowerWatts } from '../managerEnergy';
import type { ResolvedTransportPowerState } from './transportTypes';

export function resolveDevicePowerState(params: {
  device: HomeyDeviceLike;
  deviceId: string;
  deviceLabel: string;
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  livePowerWByDeviceId: LiveDevicePowerWatts;
  now: number;
  measuredPowerResolver: DeviceMeasuredPowerResolver;
  powerState: ResolvedTransportPowerState;
}): {
  currentTemperature: number | undefined;
  measuredPower: ReturnType<typeof resolveMeasuredPowerKw>;
  powerEstimate: ReturnType<typeof estimatePower>;
} {
  const {
    device, deviceId, deviceLabel, binaryCapabilityId, capabilities, capabilityObj,
    livePowerWByDeviceId, now, measuredPowerResolver, powerState,
  } = params;
  const currentTemperature = getCurrentTemperature(capabilityObj);
  const measuredPower = resolveMeasuredPowerKw({
    deviceId, deviceLabel, capabilities, capabilityObj, livePowerWByDeviceId, now,
    measuredPowerResolver, powerState,
  });
  const powerEstimate = estimatePower({
    device,
    deviceId,
    deviceLabel,
    binaryCapabilityId,
    measuredPowerKw: measuredPower.measuredPowerKw,
    now,
    state: powerState,
  });
  return { currentTemperature, measuredPower, powerEstimate };
}
