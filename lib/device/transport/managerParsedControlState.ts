import type { StructuredDebugEmitter } from '../../logging/logger';
import { getLogger } from '../../logging/logger';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { Logger } from '../../utils/types';
import {
  getCurrentOn,
  type DeviceCapabilityMap,
} from '../managerControl';
import { resolveParsedControlState } from './managerParseSnapshot';
import type { FlowReportedCapabilityId } from './flowReportedCapabilities';

const moduleLogger = getLogger('device/parsed-control-state');

export type ParsedControlStateResult = {
  currentOn?: boolean;
  canSetControl: boolean | undefined;
  observedCurrentOn?: boolean;
};

export function resolveDeviceParsedControlState(params: {
  logger: Logger;
  debugStructured?: StructuredDebugEmitter;
  deviceId: string;
  deviceName: string | null;
  deviceLabel: string;
  deviceClassKey: string;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  controlWriteCapabilityId?: string;
  capabilityObj: DeviceCapabilityMap;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: TargetDeviceSnapshot['evChargingState'];
  flowBackedCapabilityIds: FlowReportedCapabilityId[];
  previousSnapshot?: TargetDeviceSnapshot;
  suppressDropLog?: boolean;
}): ParsedControlStateResult {
  const {
    logger,
    debugStructured,
    deviceId,
    deviceName,
    deviceLabel,
    deviceClassKey,
    controlCapabilityId,
    controlWriteCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    flowBackedCapabilityIds,
    previousSnapshot,
    suppressDropLog = false,
  } = params;
  const observedCurrentOn = getCurrentOn({ deviceClassKey, capabilityObj, controlCapabilityId });
  const invalidControlPayload = hasInvalidControlPayload({ capabilityObj, controlCapabilityId });
  const candidateCurrentOn = observedCurrentOn ?? (
    invalidControlPayload
      ? resolvePreviousCurrentOn({ previousSnapshot, controlCapabilityId })
      : true
  );
  const parsedControlState = resolveParsedControlState({
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
    currentOn: candidateCurrentOn,
  });
  if (!suppressDropLog && controlCapabilityId && (observedCurrentOn === undefined || invalidControlPayload)) {
    logDroppedControlState({
      logger,
      deviceId,
      deviceName,
      deviceLabel,
      controlCapabilityId,
      capabilityObj,
    });
  }
  return {
    currentOn: parsedControlState.currentOn,
    canSetControl: parsedControlState.canSetControl,
    observedCurrentOn,
  };
}

function resolvePreviousCurrentOn(params: {
  previousSnapshot?: TargetDeviceSnapshot;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): boolean | undefined {
  const { previousSnapshot, controlCapabilityId } = params;
  if (!previousSnapshot) return undefined;
  if (previousSnapshot.controlCapabilityId !== controlCapabilityId) return undefined;
  return previousSnapshot.currentOn;
}

function hasInvalidControlPayload(params: {
  capabilityObj: DeviceCapabilityMap;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): boolean {
  const { capabilityObj, controlCapabilityId } = params;
  if (!controlCapabilityId) return false;
  const capability = capabilityObj[controlCapabilityId];
  if (!capability || !('value' in capability)) return false;
  if (capability.value === undefined) return false;
  return typeof capability.value !== 'boolean';
}

function logDroppedControlState(params: {
  logger: Logger;
  deviceId: string;
  deviceName: string | null;
  deviceLabel: string;
  controlCapabilityId: NonNullable<TargetDeviceSnapshot['controlCapabilityId']>;
  capabilityObj: DeviceCapabilityMap;
}): void {
  const {
    logger,
    deviceId,
    deviceName,
    deviceLabel,
    controlCapabilityId,
    capabilityObj,
  } = params;
  const rawValue = capabilityObj[controlCapabilityId]?.value;
  (logger.structuredLog ?? moduleLogger).error({
    event: 'device_snapshot_control_state_dropped',
    reasonCode: controlCapabilityId === 'evcharger_charging'
      ? 'missing_ev_charging_state'
      : 'missing_boolean_onoff',
    source: 'snapshot_parse',
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    deviceLabel,
    capabilityId: controlCapabilityId,
    controlCapabilityId,
    rawValue: rawValue ?? null,
    rawValueType: typeof rawValue,
  });
}
