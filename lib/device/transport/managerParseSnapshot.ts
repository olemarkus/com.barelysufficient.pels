import type { EvChargingState, TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { ParsedDeviceIdentity } from './managerParseIdentity';
import type { resolveFlowCapabilityOverlay } from '../managerNativeEv';
import { getDebugEmitter } from '../../logging/logger';
import {
  toCapabilityTimestampMs,
  type DeviceCapabilityMap,
} from '../managerControl';

const emitDeviceDebug = getDebugEmitter('devices', 'devices');

export type DeviceSnapshotControl = {
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
  hasObservedBinaryControl: boolean;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: EvChargingState | undefined;
  binaryControl: TargetDeviceSnapshot['binaryControl'];
  canSetControl: boolean | undefined;
  available: boolean;
  powerCapable: boolean;
};

export function resolveBinaryControlObservation(
  overlay: ReturnType<typeof resolveFlowCapabilityOverlay>,
  binaryCapabilityId: TransportDeviceSnapshot['binaryCapabilityId'],
): TargetDeviceSnapshot['binaryControlObservation'] {
  const { capabilityObj, binaryObservationCapabilityId } = overlay;
  if (!binaryCapabilityId) return undefined;
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

export function logSnapshotControlStateFallback(
  identity: ParsedDeviceIdentity,
  deviceName: string | null,
  capabilityObj: DeviceCapabilityMap,
  binaryCapabilityId: TransportDeviceSnapshot['binaryCapabilityId'],
  evCharging: TargetDeviceSnapshot['evCharging'],
  evChargingState: EvChargingState | undefined,
  currentOn: boolean | undefined,
): void {
  const { deviceId, deviceLabel } = identity;
  if (binaryCapabilityId === 'onoff' && typeof capabilityObj.onoff?.value !== 'boolean') {
    emitDeviceDebug({
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
    emitDeviceDebug({
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
}
