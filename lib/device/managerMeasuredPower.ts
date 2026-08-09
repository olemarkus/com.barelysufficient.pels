import type { Logger } from '../utils/types';
import type { LiveDevicePowerWatts } from './managerEnergy';
import type { DeviceCapabilityMap } from './managerControl';
import { updateLastKnownPower } from './managerRuntime';
import { readDeviceMeasuredPowerObservation } from './measuredPowerReader';
import type { DeviceMeasuredPowerResolver } from './measuredPowerResolver';
import type { ResolvedTransportPowerState } from './transport/transportTypes';

/**
 * Below this a reading is standby noise, not evidence of what the device draws
 * when working. 5 W — the floor `DeviceMeasuredPowerResolver` used to apply to
 * every reading before it was removed (it made "drawing 3 W" indistinguishable
 * from "has no meter", which is what licensed rated-power substitution).
 */
const MIN_PEAK_LEARNING_KW = 0.005;

export function resolveMeasuredPowerKw(params: {
  deviceId: string;
  deviceLabel: string;
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  livePowerWByDeviceId: LiveDevicePowerWatts;
  now: number;
  measuredPowerResolver: DeviceMeasuredPowerResolver;
  powerState: ResolvedTransportPowerState;
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
  // Peak learning is gated at the credibility floor, NOT at "any finite reading".
  // `updateLastKnownPower` keeps the max within its window, so a standby trickle
  // can rarely displace an established peak — but it CAN establish the first one,
  // and (once the window has closed on an unrepeated spike) re-anchor to one. A
  // device whose only observed draw so far is 3 W would then carry
  // `expectedPowerSource: 'measured-peak'` with a 3 W expectation into the restore
  // axis. Before `MIN_SIGNIFICANT_POWER_W` was removed from the resolver, such a
  // reading never reached here at all; this keeps that boundary where the
  // consequence lives instead of back at the producer.
  if (
    typeof measuredPower.measuredPowerKw === 'number'
    && Number.isFinite(measuredPower.measuredPowerKw)
    && measuredPower.measuredPowerKw >= MIN_PEAK_LEARNING_KW
  ) {
    updateLastKnownPower({
      state: powerState,
      logger,
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
