import {
  resolveEvChargingStateBinaryEvidence,
  toCapabilityTimestampMs,
  type DeviceCapabilityMap,
} from '../managerControl';
import type { resolveFlowCapabilityOverlay } from '../managerNativeEv';
import type { resolveMeasuredPowerKw } from '../managerMeasuredPower';
import type { DeviceSnapshotControl } from './managerParseSnapshot';

export function resolveLastFreshDataMs(
  overlay: ReturnType<typeof resolveFlowCapabilityOverlay>,
  control: DeviceSnapshotControl,
  hasTemperature: boolean,
  measuredPower: ReturnType<typeof resolveMeasuredPowerKw>,
): number | undefined {
  const { binaryCapabilityId, hasObservedBinaryControl, evChargingState } = control;
  const includeEvChargingState = evChargingState === undefined
    || resolveEvChargingStateBinaryEvidence(evChargingState) !== undefined;
  return Math.max(
    getTrackedCapabilityLastUpdatedMs(overlay.capabilityObj, [
      ...(hasObservedBinaryControl && binaryCapabilityId ? [binaryCapabilityId] : []),
      ...(hasTemperature ? ['target_temperature'] : []),
      'measure_temperature',
      ...(includeEvChargingState ? ['evcharger_charging_state'] : []),
    ]) ?? 0,
    overlay.reportedStepObservedAtMs ?? 0,
    measuredPower.observedAtMs ?? 0,
  ) || undefined;
}

function getTrackedCapabilityLastUpdatedMs(
  capabilityObj: DeviceCapabilityMap,
  trackedIds: readonly string[],
): number | undefined {
  let latest = 0;
  for (const id of trackedIds) {
    const parsed = toCapabilityTimestampMs(capabilityObj[id]?.lastUpdated);
    if (parsed !== undefined) latest = Math.max(latest, parsed);
  }
  return latest > 0 ? latest : undefined;
}
