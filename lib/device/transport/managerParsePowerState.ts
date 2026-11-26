import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { estimatePower } from '../devicePowerEstimate';
import { resolveMeasuredPowerKw } from '../managerMeasuredPower';
import { getCurrentTemperature } from './managerParse';
import { readHomeyEnergyDeviceWatts, type LiveDevicePowerWatts } from '../managerEnergy';
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
  const externalPower = deps.externalPower?.kind === 'external' ? deps.externalPower : undefined;
  const sourceDeviceId = externalPower?.socketId ?? deviceId;
  const measuredPower = resolveMeasuredPowerKw({
    deviceId, sourceDeviceId, deviceLabel, capabilities, capabilityObj,
    livePowerWByDeviceId: externalPower ? {} : livePowerWByDeviceId,
    deviceEnergyW: externalPower ? null : readHomeyEnergyDeviceWatts(device),
    now, measuredPowerResolver, powerState,
  });
  const powerEstimate = estimatePower({
    device,
    deviceId,
    sourceDeviceId,
    deviceLabel,
    binaryCapabilityId,
    measuredPowerKw: measuredPower.measuredPowerKw,
    now,
    state: powerState,
  });
  return { currentTemperature, measuredPower, powerEstimate };
}
