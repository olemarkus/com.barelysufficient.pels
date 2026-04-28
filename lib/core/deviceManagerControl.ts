import type { Logger, TargetDeviceSnapshot } from '../utils/types';

export type BinaryControlCapabilityId = 'onoff' | 'evcharger_charging';

export type BinaryControlObservation =
  | {
      valid: true;
      capabilityId: BinaryControlCapabilityId;
      observedValue: boolean;
      observedCapabilityIds: string[];
      canSettleBinary: true;
    }
  | {
      valid: false;
      capabilityId: BinaryControlCapabilityId;
      invalidControlCapabilityIds: string[];
      reasonCode: 'invalid_onoff' | 'missing_ev_charging_state';
      canSettleBinary: false;
    };

export type DeviceCapabilityValue = {
  value?: unknown;
  units?: string;
  min?: number;
  max?: number;
  step?: number;
  setable?: boolean;
  lastUpdated?: string | number | Date | null;
};

export type DeviceCapabilityMap = Record<string, DeviceCapabilityValue>;

type DeviceClassKey = string;

export function getControlCapabilityId(params: {
  deviceClassKey: DeviceClassKey;
  capabilities: string[];
}): TargetDeviceSnapshot['controlCapabilityId'] {
  const { deviceClassKey, capabilities } = params;
  if (deviceClassKey === 'evcharger' && capabilities.includes('evcharger_charging')) {
    return 'evcharger_charging';
  }
  if (capabilities.includes('onoff')) {
    return 'onoff';
  }
  return undefined;
}

export function getCurrentOn(params: {
  deviceClassKey: DeviceClassKey;
  capabilityObj: DeviceCapabilityMap;
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): boolean {
  const { deviceClassKey, capabilityObj, controlCapabilityId } = params;
  if (controlCapabilityId === 'evcharger_charging' || deviceClassKey === 'evcharger') {
    return resolveEvCurrentOn({
      evChargingState: getEvChargingState(capabilityObj),
      evchargerCharging: getEvCharging(capabilityObj),
    });
  }
  if (typeof capabilityObj.onoff?.value === 'boolean') {
    return capabilityObj.onoff.value;
  }
  return true;
}

export function resolveEvCurrentOn(params: {
  evChargingState: string | undefined;
  evchargerCharging: unknown;
}): boolean {
  const { evChargingState, evchargerCharging } = params;
  if (evchargerCharging === true) {
    return true;
  }
  if (evChargingState !== undefined) {
    return evChargingState === 'plugged_in_charging' || evChargingState === 'plugged_in_paused';
  }
  if (evchargerCharging === false) {
    return false;
  }
  return true;
}

export function resolveEvBinaryObservationFromState(
  evChargingState: string | undefined,
): boolean | string | undefined {
  switch (evChargingState) {
    case 'plugged_in_charging':
      return true;
    case 'plugged_in':
    case 'plugged_in_paused':
    case 'plugged_out':
    case 'plugged_in_discharging':
      return false;
    default:
      return evChargingState;
  }
}

export function resolveBinaryControlObservation(params: {
  capabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
  capabilityObj: DeviceCapabilityMap;
  evCharging?: boolean;
  evChargingState?: string;
}): BinaryControlObservation | undefined {
  const {
    capabilityId,
    capabilityObj,
    evCharging,
    evChargingState,
  } = params;
  if (capabilityId === 'onoff') {
    const value = capabilityObj.onoff?.value;
    if (typeof value === 'boolean') {
      return {
        valid: true,
        capabilityId,
        observedValue: value,
        observedCapabilityIds: ['onoff'],
        canSettleBinary: true,
      };
    }
    return {
      valid: false,
      capabilityId,
      invalidControlCapabilityIds: ['onoff'],
      reasonCode: 'invalid_onoff',
      canSettleBinary: false,
    };
  }
  if (capabilityId !== 'evcharger_charging') return undefined;

  const stateObservation = resolveEvBinaryObservationFromState(evChargingState);
  if (typeof stateObservation === 'boolean') {
    return {
      valid: true,
      capabilityId,
      observedValue: stateObservation,
      observedCapabilityIds: ['evcharger_charging_state'],
      canSettleBinary: true,
    };
  }
  if (evChargingState === undefined && typeof evCharging === 'boolean') {
    return {
      valid: true,
      capabilityId,
      observedValue: evCharging,
      observedCapabilityIds: ['evcharger_charging'],
      canSettleBinary: true,
    };
  }
  return {
    valid: false,
    capabilityId,
    invalidControlCapabilityIds: ['evcharger_charging_state'],
    reasonCode: 'missing_ev_charging_state',
    canSettleBinary: false,
  };
}

export function getCanSetControl(
  controlCapabilityId: TargetDeviceSnapshot['controlCapabilityId'],
  controlWriteCapabilityIdOrCapabilityObj: string | DeviceCapabilityMap | undefined = undefined,
  capabilityObj?: DeviceCapabilityMap,
): boolean | undefined {
  if (!controlCapabilityId) return undefined;
  const resolvedCapabilityObj = (
    capabilityObj
    ?? (
      typeof controlWriteCapabilityIdOrCapabilityObj === 'object'
      ? controlWriteCapabilityIdOrCapabilityObj
      : undefined
    )
  );
  if (!resolvedCapabilityObj) return undefined;
  const resolvedControlWriteCapabilityId = typeof controlWriteCapabilityIdOrCapabilityObj === 'string'
    ? controlWriteCapabilityIdOrCapabilityObj
    : undefined;
  const capability = resolvedCapabilityObj[resolvedControlWriteCapabilityId ?? controlCapabilityId];
  if (!capability) return undefined;
  if (typeof capability.setable === 'boolean') {
    return capability.setable;
  }
  return true;
}

export function getEvChargingState(capabilityObj: DeviceCapabilityMap): string | undefined {
  const value = capabilityObj.evcharger_charging_state?.value;
  return typeof value === 'string' ? value : undefined;
}

export function getEvCharging(capabilityObj: DeviceCapabilityMap): boolean | undefined {
  const value = capabilityObj.evcharger_charging?.value;
  return typeof value === 'boolean' ? value : undefined;
}

export function logEvCapabilityRequest(params: {
  logger: Logger;
  snapshotBefore?: TargetDeviceSnapshot;
  deviceId: string;
  capabilityId: string;
  value: unknown;
}): void {
  const {
    logger,
    snapshotBefore,
    deviceId,
    capabilityId,
    value,
  } = params;
  if (capabilityId !== 'evcharger_charging') return;
  logger.debug(
    `EV command requested for `
    + `${snapshotBefore ? snapshotBefore.name : `device ${deviceId}`}: ${capabilityId}=${String(value)} `
    + `(${formatEvSnapshotDetails(snapshotBefore, true)})`,
  );
}

export function logEvCapabilityAccepted(params: {
  logger: Logger;
  snapshotAfter?: TargetDeviceSnapshot;
  deviceId: string;
  capabilityId: string;
  value: unknown;
}): void {
  const {
    logger,
    snapshotAfter,
    deviceId,
    capabilityId,
    value,
  } = params;
  if (capabilityId !== 'evcharger_charging') return;
  logger.debug(
    `EV command accepted for `
    + `${snapshotAfter ? snapshotAfter.name : `device ${deviceId}`}: ${capabilityId}=${String(value)} `
    + `(${formatEvSnapshotDetails(snapshotAfter, false)})`,
  );
}

export function logEvSnapshotChanges(params: {
  logger: Logger;
  previousSnapshot: TargetDeviceSnapshot[];
  nextSnapshot: TargetDeviceSnapshot[];
}): void {
  const { logger, previousSnapshot, nextSnapshot } = params;
  const previousEvById = getEvSnapshotEntries(previousSnapshot);
  const nextEvById = getEvSnapshotEntries(nextSnapshot);

  for (const [deviceId, nextEv] of nextEvById.entries()) {
    const previousEv = previousEvById.get(deviceId);
    if (!previousEv) {
      logger.debug(`EV snapshot discovered ${nextEv.name}: ${formatEvSnapshotDiscovery(nextEv)}`);
      continue;
    }

    const changes = buildEvSnapshotChangeLines(previousEv, nextEv);
    if (changes.length > 0) {
      logger.debug(`EV snapshot changed ${nextEv.name}: ${changes.join(', ')}`);
    }
  }

  for (const [deviceId, previousEv] of previousEvById.entries()) {
    if (nextEvById.has(deviceId)) continue;
    logger.debug(`EV snapshot removed ${previousEv.name} (${deviceId})`);
  }
}

function getEvSnapshotEntries(snapshot: TargetDeviceSnapshot[]): Map<string, TargetDeviceSnapshot> {
  return new Map(
    snapshot
      .filter((device) => device.deviceClass === 'evcharger')
      .map((device) => [device.id, device]),
  );
}

function buildEvSnapshotChangeLines(
  previousEv: TargetDeviceSnapshot,
  nextEv: TargetDeviceSnapshot,
): string[] {
  const changes: string[] = [];
  if (previousEv.currentOn !== nextEv.currentOn) {
    changes.push(`currentOn ${String(previousEv.currentOn)} -> ${String(nextEv.currentOn)}`);
  }
  if (previousEv.evChargingState !== nextEv.evChargingState) {
    changes.push(`evState ${previousEv.evChargingState ?? 'unknown'} -> ${nextEv.evChargingState ?? 'unknown'}`);
  }
  if (previousEv.available !== nextEv.available) {
    changes.push(`available ${String(previousEv.available !== false)} -> ${String(nextEv.available !== false)}`);
  }
  if (previousEv.controlCapabilityId !== nextEv.controlCapabilityId) {
    changes.push(
      `control ${previousEv.controlCapabilityId ?? 'unknown'} `
      + `-> ${nextEv.controlCapabilityId ?? 'unknown'}`,
    );
  }
  const previousPower = previousEv.powerKw ?? previousEv.measuredPowerKw;
  const nextPower = nextEv.powerKw ?? nextEv.measuredPowerKw;
  if (previousPower !== nextPower) {
    changes.push(`powerKw ${previousPower ?? 'unknown'} -> ${nextPower ?? 'unknown'}`);
  }
  return changes;
}

function formatEvSnapshotDiscovery(snapshot: TargetDeviceSnapshot): string {
  return [
    `currentOn=${String(snapshot.currentOn)}`,
    `evState=${snapshot.evChargingState ?? 'unknown'}`,
    `available=${snapshot.available !== false}`,
    `powerKw=${snapshot.powerKw ?? snapshot.measuredPowerKw ?? 'unknown'}`,
    `control=${snapshot.controlCapabilityId ?? 'unknown'}`,
  ].join(', ');
}

function formatEvSnapshotDetails(
  snapshot: TargetDeviceSnapshot | undefined,
  includePower: boolean,
): string {
  const details = [
    `currentOn=${String(snapshot?.currentOn)}`,
    `evState=${snapshot?.evChargingState ?? 'unknown'}`,
  ];
  if (includePower) {
    details.push(`available=${snapshot?.available !== false}`);
    details.push(`powerKw=${snapshot?.powerKw ?? snapshot?.measuredPowerKw ?? 'unknown'}`);
  }
  return details.join(', ');
}
