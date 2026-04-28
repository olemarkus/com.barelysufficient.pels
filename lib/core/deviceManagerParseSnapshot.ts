import type { Logger, TargetDeviceSnapshot } from '../utils/types';
import { getCanSetControl, type DeviceCapabilityMap } from './deviceManagerControl';
import type { FlowReportedCapabilityId } from './flowReportedCapabilities';

export type ControlObservationValidity =
  | {
    valid: true;
    observedControlCapabilityIds: string[];
    canSettleBinary: true;
  }
  | {
    valid: false;
    invalidControlCapabilityIds: string[];
    reasonCode: 'invalid_onoff' | 'missing_ev_charging_state';
    canSettleBinary: false;
  };

export function resolveParsedControlState(params: {
  logger: Logger;
  deviceId: string;
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
  controlObservation: ControlObservationValidity;
} {
  const {
    logger,
    deviceId,
    deviceLabel,
    controlCapabilityId,
    controlWriteCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    flowBackedCapabilityIds,
    currentOn,
  } = params;
  const controlObservation = resolveControlObservationValidity({
    logger,
    deviceId,
    deviceLabel,
    controlCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
  });
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
    controlObservation,
  };
}

export function resolveLastFreshDataMs(params: {
  capabilityObj: DeviceCapabilityMap;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  targetCaps: readonly string[];
  measuredPowerObservedAtMs?: number;
  invalidControlCapabilityIds?: readonly string[];
}): number | undefined {
  const {
    capabilityObj,
    controlCapabilityId,
    targetCaps,
    measuredPowerObservedAtMs,
    invalidControlCapabilityIds = [],
  } = params;
  const invalidControlCapabilityIdSet = new Set(invalidControlCapabilityIds);
  return Math.max(
    getTrackedCapabilityLastUpdatedMs(capabilityObj, [
      ...(controlCapabilityId && !invalidControlCapabilityIdSet.has(controlCapabilityId) ? [controlCapabilityId] : []),
      ...targetCaps,
      'measure_temperature',
      ...(invalidControlCapabilityIdSet.has('evcharger_charging_state') ? [] : ['evcharger_charging_state']),
    ]) ?? 0,
    measuredPowerObservedAtMs ?? 0,
  ) || undefined;
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

function resolveControlObservationValidity(params: {
  logger: Logger;
  deviceId: string;
  deviceLabel: string;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  capabilityObj: DeviceCapabilityMap;
  evCharging: TargetDeviceSnapshot['evCharging'];
  evChargingState: TargetDeviceSnapshot['evChargingState'];
  report?: boolean;
}): ControlObservationValidity {
  const {
    logger,
    deviceId,
    deviceLabel,
    controlCapabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
    report = true,
  } = params;
  let controlObservation: ControlObservationValidity = {
    valid: true,
    observedControlCapabilityIds: [],
    canSettleBinary: true,
  };
  if (controlCapabilityId === 'onoff') {
    if (typeof capabilityObj.onoff?.value === 'boolean') {
      controlObservation = {
        valid: true,
        observedControlCapabilityIds: ['onoff'],
        canSettleBinary: true,
      };
    } else {
      controlObservation = {
        valid: false,
        invalidControlCapabilityIds: ['onoff'],
        reasonCode: 'invalid_onoff',
        canSettleBinary: false,
      };
    }
  } else if (controlCapabilityId === 'evcharger_charging') {
    const observedControlCapabilityIds = [
      ...(evCharging !== undefined ? ['evcharger_charging'] : []),
      ...(evChargingState !== undefined ? ['evcharger_charging_state'] : []),
    ];
    if (observedControlCapabilityIds.length > 0) {
      controlObservation = {
        valid: true,
        observedControlCapabilityIds,
        canSettleBinary: true,
      };
    } else {
      controlObservation = {
        valid: false,
        invalidControlCapabilityIds: ['evcharger_charging', 'evcharger_charging_state'],
        reasonCode: 'missing_ev_charging_state',
        canSettleBinary: false,
      };
    }
  }
  if (report) {
    reportInvalidControlObservation({
      logger,
      deviceId,
      deviceLabel,
      controlObservation,
    });
  }
  return controlObservation;
}

function reportInvalidControlObservation(params: {
  logger: Logger;
  deviceId: string;
  deviceLabel: string;
  controlObservation: ControlObservationValidity;
}): void {
  const {
    logger,
    deviceId,
    deviceLabel,
    controlObservation,
  } = params;
  if (controlObservation.valid) return;
  logger.structuredLog?.error({
    event: 'invalid_control_observation',
    reasonCode: controlObservation.reasonCode,
    deviceId,
    deviceName: deviceLabel,
    invalidControlCapabilityIds: controlObservation.invalidControlCapabilityIds,
  });
}

function getTrackedCapabilityLastUpdatedMs(
  capabilityObj: DeviceCapabilityMap,
  trackedIds: readonly string[],
): number | undefined {
  let latest = 0;
  for (const id of trackedIds) {
    const rawValue = capabilityObj[id]?.lastUpdated;
    let parsed: number | undefined;
    if (rawValue instanceof Date) parsed = rawValue.getTime();
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) parsed = rawValue;
    else if (typeof rawValue === 'string') {
      const nextParsed = Date.parse(rawValue);
      if (Number.isFinite(nextParsed)) parsed = nextParsed;
    }
    if (parsed !== undefined) latest = Math.max(latest, parsed);
  }
  return latest > 0 ? latest : undefined;
}
