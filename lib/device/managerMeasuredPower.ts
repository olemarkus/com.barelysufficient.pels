import type { LiveDevicePowerWatts } from './managerEnergy';
import type { DeviceCapabilityMap } from './managerControl';
import { updateLastKnownPower } from './managerRuntime';
import { readDeviceMeasuredPowerObservation } from './measuredPowerReader';
import type { DeviceMeasuredPowerResolution, DeviceMeasuredPowerResolver } from './measuredPowerResolver';
import type { ResolvedTransportPowerState } from './transport/transportTypes';

export function resolveMeasuredPowerKw(params: {
  deviceId: string;
  sourceDeviceId: string;
  deviceLabel: string;
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  livePowerWByDeviceId: LiveDevicePowerWatts;
  deviceEnergyW: number | null;
  now: number;
  measuredPowerResolver: DeviceMeasuredPowerResolver;
  powerState: ResolvedTransportPowerState;
}): DeviceMeasuredPowerResolution & { meterEnergy?: import('./measuredPowerReader').MeterEnergyReading } {
  const {
    deviceId,
    sourceDeviceId,
    deviceLabel,
    capabilities,
    capabilityObj,
    livePowerWByDeviceId,
    deviceEnergyW,
    now,
    measuredPowerResolver,
    powerState,
  } = params;
  const observation = readDeviceMeasuredPowerObservation({
    deviceId, capabilities, capabilityObj, livePowerWByDeviceId, deviceEnergyW, homeyEnergyObservedAtMs: now,
  });
  const measuredPower = measuredPowerResolver.resolve({ deviceId, deviceLabel, observation });
  // Report the binding even before it has a reading so learning cannot mix
  // samples across successive sources. Standby readings also reach the learner.
  updateLastKnownPower({
    state: powerState,
    deviceId,
    sourceDeviceId,
    measuredKw: measuredPower.measuredPowerKw,
    deviceLabel,
    // WHEN PELS READ IT, not the capability's `lastUpdated`: Homey reports on
    // change, so a steady device would otherwise have its peak expire.
    nowMs: now,
    onPeakChanged: powerState.onLearnedPeakChanged,
  });
  return { ...measuredPower, meterEnergy: observation.meterEnergy };
}
