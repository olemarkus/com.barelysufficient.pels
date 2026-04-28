import type { Logger, TargetDeviceSnapshot } from '../utils/types';
import {
  getCanSetControl,
  toCapabilityTimestampMs,
  type DeviceCapabilityMap,
} from './deviceManagerControl';
import type { FlowReportedCapabilityId } from './flowReportedCapabilities';

export function resolveParsedControlState(params: {
  logger: Logger;
  deviceLabel: string;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  controlWriteCapabilityId?: string;
  capabilityObj: DeviceCapabilityMap;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: TargetDeviceSnapshot['evChargingState'];
  flowBackedCapabilityIds: FlowReportedCapabilityId[];
  currentOn: boolean;
}): {
  currentOn: boolean;
  canSetControl: boolean | undefined;
} {
  const {
    logger,
    deviceLabel,
    controlCapabilityId,
    controlWriteCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    flowBackedCapabilityIds,
    currentOn,
  } = params;
  return {
    currentOn: resolveSnapshotCurrentOn({
      logger,
      deviceLabel,
      controlCapabilityId,
      capabilityObj,
      evCharging,
      evChargingState,
      currentOn,
    }),
    canSetControl: controlCapabilityId && flowBackedCapabilityIds.includes(controlCapabilityId)
      ? true
      : getCanSetControl(controlCapabilityId, controlWriteCapabilityId, capabilityObj),
  };
}

export function resolveLastFreshDataMs(params: {
  capabilityObj: DeviceCapabilityMap;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  targetCaps: readonly string[];
  measuredPowerObservedAtMs?: number;
}): number | undefined {
  const {
    capabilityObj,
    controlCapabilityId,
    targetCaps,
    measuredPowerObservedAtMs,
  } = params;
  return Math.max(
    getTrackedCapabilityLastUpdatedMs(capabilityObj, [
      ...(controlCapabilityId ? [controlCapabilityId] : []),
      ...targetCaps,
      'measure_temperature',
      'evcharger_charging_state',
    ]) ?? 0,
    measuredPowerObservedAtMs ?? 0,
  ) || undefined;
}

export function resolveBinaryControlObservation(params: {
  capabilityObj: DeviceCapabilityMap;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  controlObservationCapabilityId?: string;
}): TargetDeviceSnapshot['binaryControlObservation'] {
  const {
    capabilityObj,
    controlCapabilityId,
    controlObservationCapabilityId,
  } = params;
  if (!controlCapabilityId) return undefined;
  const sourceCapabilityId = controlObservationCapabilityId ?? controlCapabilityId;
  const sourceCapability = capabilityObj[sourceCapabilityId];
  const observedAtMs = toCapabilityTimestampMs(sourceCapability?.lastUpdated);
  if (observedAtMs === undefined) return undefined;
  const observedValue = sourceCapability?.value;
  if (typeof observedValue !== 'boolean') return undefined;
  return {
    valid: true,
    capabilityId: controlCapabilityId,
    observedValue,
    observedCapabilityIds: [sourceCapabilityId],
    observedAtMs,
  };
}

function resolveSnapshotCurrentOn(params: {
  logger: Logger;
  deviceLabel: string;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  capabilityObj: DeviceCapabilityMap;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: TargetDeviceSnapshot['evChargingState'];
  currentOn: boolean;
}): boolean {
  const {
    logger,
    deviceLabel,
    controlCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    currentOn,
  } = params;
  if (controlCapabilityId === 'onoff' && typeof capabilityObj.onoff?.value !== 'boolean') {
    logger.debug(
      `Snapshot missing boolean onoff value for ${deviceLabel}; assuming device is on`,
      capabilityObj.onoff?.value,
    );
  } else if (
    controlCapabilityId === 'evcharger_charging'
    && evCharging === undefined
    && evChargingState === undefined
  ) {
    logger.debug(
      `Snapshot missing EV charging state for ${deviceLabel}; assuming device is on`,
    );
  }
  return currentOn;
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
