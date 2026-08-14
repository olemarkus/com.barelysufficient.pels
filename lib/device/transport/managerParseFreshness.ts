import type { EvChargingState } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { resolveEvChargingStateBinaryEvidence, type DeviceCapabilityMap } from '../managerControl';
import { resolveLastFreshDataMs } from './managerParseSnapshot';

export function resolveParsedLastFreshDataMs(params: {
  capabilityObj: DeviceCapabilityMap;
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
  hasObservedBinaryControl: boolean;
  evChargingState: EvChargingState | undefined;
  hasTemperature: boolean;
  reportedStepObservedAtMs?: number;
  measuredPowerObservedAtMs?: number;
}): number | undefined {
  const {
    capabilityObj,
    binaryCapabilityId,
    hasObservedBinaryControl,
    evChargingState,
    hasTemperature,
    reportedStepObservedAtMs,
    measuredPowerObservedAtMs,
  } = params;
  return resolveLastFreshDataMs({
    capabilityObj,
    binaryCapabilityId: hasObservedBinaryControl ? binaryCapabilityId : undefined,
    includeEvChargingState: evChargingState === undefined
      || resolveEvChargingStateBinaryEvidence(evChargingState) !== undefined,
    targetCaps: hasTemperature ? ['target_temperature'] : [],
    observedCapabilityAtMs: reportedStepObservedAtMs,
    measuredPowerObservedAtMs,
  });
}
