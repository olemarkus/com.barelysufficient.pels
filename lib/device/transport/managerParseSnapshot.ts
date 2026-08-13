import type { EvChargingState, TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { getLogger } from '../../logging/logger';
import {
  getCanSetControl,
  toCapabilityTimestampMs,
  type DeviceCapabilityMap,
} from '../managerControl';

const moduleLogger = getLogger('device/parse-snapshot');

export function resolveParsedControlState(params: {
  debugStructured?: StructuredDebugEmitter;
  deviceId: string;
  deviceName: string | null;
  deviceLabel: string;
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
  binaryWriteCapabilityId?: string;
  capabilityObj: DeviceCapabilityMap;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: EvChargingState | undefined;
  // Only a membership test happens below, so the narrow `FlowReportedCapabilityId[]`
  // is unnecessary here — accept any capability-id list. Lets `binaryCapabilityId`
  // (an open `BinaryControlCapabilityId`) be tested without a type assertion.
  flowBackedCapabilityIds: readonly string[];
  currentOn?: boolean;
}): {
  resolvedOn?: boolean;
  canSetControl: boolean | undefined;
} {
  const {
    debugStructured,
    deviceId,
    deviceName,
    deviceLabel,
    binaryCapabilityId,
    binaryWriteCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    flowBackedCapabilityIds,
    currentOn,
  } = params;
  return {
    resolvedOn: resolveSnapshotCurrentOn({
      debugStructured,
      deviceId,
      deviceName,
      deviceLabel,
      binaryCapabilityId,
      capabilityObj,
      evCharging,
      evChargingState,
      currentOn,
    }),
    canSetControl: binaryCapabilityId
      && flowBackedCapabilityIds.includes(binaryCapabilityId)
      ? true
      : getCanSetControl(binaryCapabilityId, binaryWriteCapabilityId, capabilityObj),
  };
}

export function resolveLastFreshDataMs(params: {
  capabilityObj: DeviceCapabilityMap;
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
  includeEvChargingState?: boolean;
  targetCaps: readonly string[];
  observedCapabilityAtMs?: number;
  measuredPowerObservedAtMs?: number;
}): number | undefined {
  const {
    capabilityObj,
    binaryCapabilityId,
    includeEvChargingState = true,
    targetCaps,
    observedCapabilityAtMs,
    measuredPowerObservedAtMs,
  } = params;
  return Math.max(
    getTrackedCapabilityLastUpdatedMs(capabilityObj, [
      ...(binaryCapabilityId ? [binaryCapabilityId] : []),
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
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
  binaryObservationCapabilityId?: string;
}): TargetDeviceSnapshot['binaryControlObservation'] {
  const {
    capabilityObj,
    binaryCapabilityId,
    binaryObservationCapabilityId,
  } = params;
  if (!binaryCapabilityId) return undefined;
  if (binaryCapabilityId === 'evcharger_charging') {
    return resolveEvBinaryControlObservation({
      capabilityObj,
      binaryObservationCapabilityId,
    });
  }
  const sourceCapabilityId = binaryObservationCapabilityId ?? binaryCapabilityId;
  const sourceCapability = capabilityObj[sourceCapabilityId];
  const observedAtMs = toCapabilityTimestampMs(sourceCapability?.lastUpdated);
  if (observedAtMs === undefined) return undefined;
  const observedValue = sourceCapability?.value;
  if (typeof observedValue !== 'boolean') return undefined;
  return {
    valid: true,
    capabilityId: binaryCapabilityId,
    observedValue,
    observedCapabilityIds: [sourceCapabilityId],
    observedAtMs,
    source: 'snapshot_refresh',
  };
}

function resolveEvBinaryControlObservation(params: {
  capabilityObj: DeviceCapabilityMap;
  binaryObservationCapabilityId?: string;
}): TargetDeviceSnapshot['binaryControlObservation'] {
  const { capabilityObj, binaryObservationCapabilityId } = params;
  const sourceCapabilityId = binaryObservationCapabilityId ?? 'evcharger_charging';
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
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
  capabilityObj: DeviceCapabilityMap;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: EvChargingState | undefined;
  currentOn?: boolean;
}): boolean | undefined {
  const {
    debugStructured,
    deviceId,
    deviceName,
    deviceLabel,
    binaryCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    currentOn,
  } = params;
  if (binaryCapabilityId === 'onoff' && typeof capabilityObj.onoff?.value !== 'boolean') {
    (debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
      event: 'device_snapshot_control_state_fallback',
      reasonCode: 'missing_boolean_onoff',
      source: 'snapshot_refresh',
      deviceId,
      deviceName,
      deviceLabel,
      capabilityId: 'onoff',
      binaryCapabilityId,
      rawValue: capabilityObj.onoff?.value ?? null,
      rawValueType: typeof capabilityObj.onoff?.value,
      fallbackCurrentOn: currentOn,
    });
  } else if (
    binaryCapabilityId === 'evcharger_charging'
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
      binaryCapabilityId,
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
