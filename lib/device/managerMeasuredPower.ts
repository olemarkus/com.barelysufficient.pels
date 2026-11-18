import type { LiveDevicePowerWatts } from './managerEnergy';
import type { DeviceCapabilityMap } from './managerControl';
import { updateLastKnownPower } from './managerRuntime';
import { readDeviceMeasuredPowerObservation } from './measuredPowerReader';
import type { DeviceMeasuredPowerResolution, DeviceMeasuredPowerResolver } from './measuredPowerResolver';
import type { ResolvedTransportPowerState } from './transport/transportTypes';

export function resolveMeasuredPowerKw(params: {
  deviceId: string;
  deviceLabel: string;
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  livePowerWByDeviceId: LiveDevicePowerWatts;
  deviceEnergyW: number | null;
  now: number;
  measuredPowerResolver: DeviceMeasuredPowerResolver;
  powerState: ResolvedTransportPowerState;
}): DeviceMeasuredPowerResolution {
  const {
    deviceId,
    deviceLabel,
    capabilities,
    capabilityObj,
    livePowerWByDeviceId,
    deviceEnergyW,
    now,
    measuredPowerResolver,
    powerState,
  } = params;
  const measuredPower = measuredPowerResolver.resolve({
    deviceId,
    deviceLabel,
    observation: readDeviceMeasuredPowerObservation({
      deviceId,
      capabilities,
      capabilityObj,
      livePowerWByDeviceId,
      deviceEnergyW,
      homeyEnergyObservedAtMs: now,
    }),
  });
  // Every accepted reading goes to peak learning, which applies its own
  // credibility floor (`MIN_PEAK_LEARNING_KW`): it needs the standby readings
  // too, to tell one running reading from the next.
  if (typeof measuredPower.measuredPowerKw === 'number' && Number.isFinite(measuredPower.measuredPowerKw)) {
    updateLastKnownPower({
      state: powerState,
      deviceId,
      measuredKw: measuredPower.measuredPowerKw,
      deviceLabel,
      // WHEN PELS READ IT, not the capability's `lastUpdated`: Homey reports on
      // change, so a device steady at its peak stops republishing and would
      // otherwise have its peak expire for holding still.
      nowMs: now,
      onPeakChanged: powerState.onLearnedPeakChanged,
    });
  }
  return measuredPower;
}
