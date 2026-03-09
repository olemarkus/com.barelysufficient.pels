import type { Logger, TargetDeviceSnapshot } from '../utils/types';

export type DeviceCapabilityValue = {
  value?: unknown;
  units?: string;
  setable?: boolean;
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
}): boolean | undefined {
  const { deviceClassKey, capabilityObj, controlCapabilityId } = params;
  if (controlCapabilityId === 'evcharger_charging' || deviceClassKey === 'evcharger') {
    if (typeof capabilityObj.evcharger_charging?.value === 'boolean') {
      return capabilityObj.evcharger_charging.value;
    }
    const evChargingState = getEvChargingState(capabilityObj);
    if (evChargingState === undefined) return undefined;
    return evChargingState === 'plugged_in_charging';
  }
  if (typeof capabilityObj.onoff?.value === 'boolean') {
    return capabilityObj.onoff.value;
  }
  return undefined;
}

export function getCanSetControl(
  controlCapabilityId: TargetDeviceSnapshot['controlCapabilityId'],
  capabilityObj: DeviceCapabilityMap,
): boolean | undefined {
  if (!controlCapabilityId) return undefined;
  const capability = capabilityObj[controlCapabilityId];
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

export function buildOptimisticCapabilityUpdate(
  capabilityId: string,
  value: unknown,
): { target?: number | null; on?: boolean } | null {
  if (capabilityId.startsWith('target_temperature') && typeof value === 'number') {
    return { target: value };
  }
  return null;
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
    `EV command requested for ${snapshotBefore?.name || deviceId}: ${capabilityId}=${String(value)} `
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
    `EV command accepted for ${snapshotAfter?.name || deviceId}: ${capabilityId}=${String(value)} `
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
