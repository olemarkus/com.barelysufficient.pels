import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { estimatePower } from '../devicePowerEstimate';
import { resolveMeasuredPowerKw } from '../managerMeasuredPower';
import { getCurrentTemperature } from './managerParse';
import type { LiveDevicePowerWatts } from '../managerEnergy';
import type { resolveFlowCapabilityOverlay } from '../managerNativeEv';
import type { DeviceTransportParseDeps } from './managerParseDevice';
import type { ParsedDeviceIdentity } from './managerParseIdentity';

export function resolveDevicePowerState(
  identity: ParsedDeviceIdentity,
  deps: DeviceTransportParseDeps,
  overlay: ReturnType<typeof resolveFlowCapabilityOverlay>,
  binaryCapabilityId: TransportDeviceSnapshot['binaryCapabilityId'],
  livePowerWByDeviceId: LiveDevicePowerWatts,
  now: number,
): {
  currentTemperature: number | undefined;
  measuredPower: ReturnType<typeof resolveMeasuredPowerKw>;
  powerEstimate: ReturnType<typeof estimatePower>;
} {
  const { effectiveDevice: device, deviceId, deviceLabel } = identity;
  const { measuredPowerResolver, powerState } = deps;
  const { capabilities, capabilityObj } = overlay;
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
