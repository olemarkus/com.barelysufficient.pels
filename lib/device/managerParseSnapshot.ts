import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';
import {
  getCanSetControl,
  resolveEvChargingStateBinaryEvidence,
  toCapabilityTimestampMs,
  type DeviceCapabilityMap,
} from './managerControl';
import type { FlowReportedCapabilityId } from './flowReportedCapabilities';

const moduleLogger = getLogger('device/parse-snapshot');

export function resolveParsedControlState(params: {
  debugStructured?: StructuredDebugEmitter;
  deviceId: string;
  deviceName: string | null;
  deviceLabel: string;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  controlWriteCapabilityId?: string;
  capabilityObj: DeviceCapabilityMap;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: TargetDeviceSnapshot['evChargingState'];
  flowBackedCapabilityIds: FlowReportedCapabilityId[];
  currentOn?: boolean;
}): {
  currentOn?: boolean;
  canSetControl: boolean | undefined;
} {
  const {
    debugStructured,
    deviceId,
    deviceName,
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
      debugStructured,
      deviceId,
      deviceName,
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
  includeEvChargingState?: boolean;
  targetCaps: readonly string[];
  observedCapabilityAtMs?: number;
  measuredPowerObservedAtMs?: number;
}): number | undefined {
  const {
    capabilityObj,
    controlCapabilityId,
    includeEvChargingState = true,
    targetCaps,
    observedCapabilityAtMs,
    measuredPowerObservedAtMs,
  } = params;
  return Math.max(
    getTrackedCapabilityLastUpdatedMs(capabilityObj, [
      ...(controlCapabilityId ? [controlCapabilityId] : []),
      ...targetCaps,
      'measure_temperature',
      ...(includeEvChargingState ? ['evcharger_charging_state'] : []),
    ]) ?? 0,
    observedCapabilityAtMs ?? 0,
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
  if (controlCapabilityId === 'evcharger_charging') {
    return resolveEvBinaryControlObservation({
      capabilityObj,
      controlObservationCapabilityId,
    });
  }
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
    source: 'snapshot_refresh',
  };
}

function resolveEvBinaryControlObservation(params: {
  capabilityObj: DeviceCapabilityMap;
  controlObservationCapabilityId?: string;
}): TargetDeviceSnapshot['binaryControlObservation'] {
  const { capabilityObj, controlObservationCapabilityId } = params;
  const rawStateValue = capabilityObj.evcharger_charging_state?.value;
  if (rawStateValue !== undefined) {
    const observedValue = resolveEvChargingStateBinaryEvidence(rawStateValue);
    if (observedValue === undefined) return undefined;
    const observedAtMs = toCapabilityTimestampMs(capabilityObj.evcharger_charging_state?.lastUpdated);
    if (observedAtMs === undefined) return undefined;
    return {
      valid: true,
      capabilityId: 'evcharger_charging',
      observedValue,
      observedCapabilityIds: ['evcharger_charging_state'],
      observedAtMs,
      source: 'snapshot_refresh',
    };
  }

  const sourceCapabilityId = controlObservationCapabilityId ?? 'evcharger_charging';
  const sourceCapability = capabilityObj[sourceCapabilityId];
  const observedAtMs = toCapabilityTimestampMs(sourceCapability?.lastUpdated);
  if (observedAtMs === undefined) return undefined;
  const observedValue = sourceCapability?.value;
  if (typeof observedValue !== 'boolean') return undefined;
  return {
    valid: true,
    capabilityId: 'evcharger_charging',
    observedValue,
    observedCapabilityIds: [sourceCapabilityId],
    observedAtMs,
    source: 'snapshot_refresh',
  };
}

function resolveSnapshotCurrentOn(params: {
  debugStructured?: StructuredDebugEmitter;
  deviceId: string;
  deviceName: string | null;
  deviceLabel: string;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  capabilityObj: DeviceCapabilityMap;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: TargetDeviceSnapshot['evChargingState'];
  currentOn?: boolean;
}): boolean | undefined {
  const {
    debugStructured,
    deviceId,
    deviceName,
    deviceLabel,
    controlCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    currentOn,
  } = params;
  if (controlCapabilityId === 'onoff' && typeof capabilityObj.onoff?.value !== 'boolean') {
    (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
      event: 'device_snapshot_control_state_fallback',
      reasonCode: 'missing_boolean_onoff',
      source: 'snapshot_refresh',
      deviceId,
      deviceName,
      deviceLabel,
      capabilityId: 'onoff',
      controlCapabilityId,
      rawValue: capabilityObj.onoff?.value ?? null,
      rawValueType: typeof capabilityObj.onoff?.value,
      fallbackCurrentOn: currentOn,
    });
  } else if (
    controlCapabilityId === 'evcharger_charging'
    && evCharging === undefined
    && evChargingState === undefined
  ) {
    (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
      event: 'device_snapshot_control_state_fallback',
      reasonCode: 'missing_ev_charging_state',
      source: 'snapshot_refresh',
      deviceId,
      deviceName,
      deviceLabel,
      capabilityId: 'evcharger_charging',
      controlCapabilityId,
      rawValue: null,
      rawValueType: 'undefined',
      fallbackCurrentOn: currentOn,
    });
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
