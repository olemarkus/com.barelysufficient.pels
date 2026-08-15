import type { EvChargingState } from '../../packages/contracts/src/types';
import { isEvChargingState } from '../../packages/shared-domain/src/evPlugState';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { resolveBinaryOn } from '../utils/binaryControl';
import type { Logger } from '../utils/types';

export type DeviceCapabilityValue = {
  value?: unknown;
  units?: string;
  min?: number;
  max?: number;
  step?: number;
  excludeMin?: number;
  excludeMax?: number;
  setable?: boolean;
  lastUpdated?: string | number | Date | null;
};

export type DeviceCapabilityMap = Record<string, DeviceCapabilityValue>;

type DeviceClassKey = string;

export function getControlCapabilityId(params: {
  deviceClassKey: DeviceClassKey;
  capabilities: string[];
}): TransportDeviceSnapshot['binaryCapabilityId'] {
  const { deviceClassKey, capabilities } = params;
  if (deviceClassKey === 'evcharger' && capabilities.includes('evcharger_charging')) {
    return 'evcharger_charging';
  }
  if (capabilities.includes('onoff')) {
    return 'onoff';
  }
  return undefined;
}

/**
 * Reads the device's observed binary control state ("may it draw power?").
 *
 * Returns `undefined` only when there is no trusted boolean to read. At runtime
 * that means the device simply has no binary control. A device that HAS `onoff`
 * (or `evcharger_charging`) always reports a value, so the `undefined` return for
 * a binary device is a *type-level* possibility only — `capabilitiesObj[id].value`
 * is typed `unknown` and the entry is optional in the Homey SDK types, not a real
 * "binary device went unobserved" state. Callers must not treat `undefined` as an
 * observed "off"; the contractual non-optional `currentOn` is synthesized from
 * this at the parse boundary — see `resolveUnobservedControlFallback`.
 */
export function getCurrentOn(params: {
  deviceClassKey: DeviceClassKey;
  capabilityObj: DeviceCapabilityMap;
  binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
}): boolean | undefined {
  const { capabilityObj, binaryCapabilityId } = params;
  if (binaryCapabilityId === 'evcharger_charging') {
    return resolveEvCurrentOnObservation({
      evchargerCharging: getEvCharging(capabilityObj),
    });
  }
  if (typeof capabilityObj.onoff?.value === 'boolean') {
    return capabilityObj.onoff.value;
  }
  return undefined;
}

export function resolveEvCurrentOn(params: {
  evchargerCharging: unknown;
}): boolean {
  const { evchargerCharging } = params;
  // `evcharger_charging` is the command/readback axis. Charging-state telemetry
  // answers whether energy is physically flowing, which is deliberately a
  // separate fact: the car may refuse to charge after the command was accepted.
  if (evchargerCharging === true) {
    return true;
  }
  if (evchargerCharging === false) {
    return false;
  }
  return true;
}

export function resolveEvCurrentOnObservation(params: {
  evchargerCharging: unknown;
}): boolean | undefined {
  const { evchargerCharging } = params;
  // Only a read of the command capability is a command-state observation.
  if (evchargerCharging === true) return true;
  if (evchargerCharging === false) return false;
  return undefined;
}

export function resolveEvChargingStateBinaryEvidence(evChargingState: unknown): boolean | undefined {
  switch (evChargingState) {
    case 'plugged_in_charging':
      return true;
    case 'plugged_in':
    case 'plugged_in_paused':
    case 'plugged_out':
    case 'plugged_in_discharging':
      return false;
    default:
      return undefined;
  }
}

export function getCanSetControl(
  binaryCapabilityId: TransportDeviceSnapshot['binaryCapabilityId'],
  binaryWriteCapabilityIdOrCapabilityObj: string | DeviceCapabilityMap | undefined = undefined,
  capabilityObj?: DeviceCapabilityMap,
): boolean | undefined {
  if (!binaryCapabilityId) return undefined;
  const resolvedCapabilityObj = (
    capabilityObj
    ?? (
      typeof binaryWriteCapabilityIdOrCapabilityObj === 'object'
      ? binaryWriteCapabilityIdOrCapabilityObj
      : undefined
    )
  );
  if (!resolvedCapabilityObj) return undefined;
  const resolvedControlWriteCapabilityId = typeof binaryWriteCapabilityIdOrCapabilityObj === 'string'
    ? binaryWriteCapabilityIdOrCapabilityObj
    : undefined;
  const capability = resolvedCapabilityObj[resolvedControlWriteCapabilityId ?? binaryCapabilityId];
  if (!capability) return undefined;
  if (typeof capability.setable === 'boolean') {
    return capability.setable;
  }
  return true;
}

// Capability-read parse seam: `evcharger_charging_state` is a closed Homey enum,
// so a value outside the set (or a non-string) normalises to `undefined` — the
// same outcome consumers' literal comparisons already produced for it.
export function getEvChargingState(capabilityObj: DeviceCapabilityMap): EvChargingState | undefined {
  const value = capabilityObj.evcharger_charging_state?.value;
  return isEvChargingState(value) ? value : undefined;
}

export function getEvCharging(capabilityObj: DeviceCapabilityMap): boolean | undefined {
  const value = capabilityObj.evcharger_charging?.value;
  return typeof value === 'boolean' ? value : undefined;
}

export function toCapabilityTimestampMs(rawValue: string | number | Date | null | undefined): number | undefined {
  if (rawValue instanceof Date) {
    const timestampMs = rawValue.getTime();
    return Number.isFinite(timestampMs) ? timestampMs : undefined;
  }
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
  if (typeof rawValue === 'string') {
    const parsed = Date.parse(rawValue);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function logEvCapabilityRequest(params: {
  logger: Logger;
  snapshotBefore?: TransportDeviceSnapshot;
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
  logger.debug({
    event: 'ev_command_requested',
    deviceId,
    deviceName: snapshotBefore?.name,
    capabilityId,
    value: String(value),
    detail: formatEvSnapshotDetails(snapshotBefore, true),
  });
}

export function logEvCapabilityAccepted(params: {
  logger: Logger;
  snapshotAfter?: TransportDeviceSnapshot;
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
  logger.debug({
    event: 'ev_command_accepted',
    deviceId,
    deviceName: snapshotAfter?.name,
    capabilityId,
    value: String(value),
    detail: formatEvSnapshotDetails(snapshotAfter, false),
  });
}

export function logEvSnapshotChanges(params: {
  logger: Logger;
  previousSnapshot: TransportDeviceSnapshot[];
  nextSnapshot: TransportDeviceSnapshot[];
}): void {
  const { logger, previousSnapshot, nextSnapshot } = params;
  const previousEvById = getEvSnapshotEntries(previousSnapshot);
  const nextEvById = getEvSnapshotEntries(nextSnapshot);

  for (const [deviceId, nextEv] of nextEvById.entries()) {
    const previousEv = previousEvById.get(deviceId);
    if (!previousEv) {
      logger.debug({
        event: 'ev_snapshot_discovered',
        deviceId,
        deviceName: nextEv.name,
        detail: formatEvSnapshotDiscovery(nextEv),
      });
      continue;
    }

    const changes = buildEvSnapshotChangeLines(previousEv, nextEv);
    if (changes.length > 0) {
      logger.debug({
        event: 'ev_snapshot_changed',
        deviceId,
        deviceName: nextEv.name,
        changes,
      });
    }
  }

  for (const [deviceId, previousEv] of previousEvById.entries()) {
    if (nextEvById.has(deviceId)) continue;
    logger.debug({ event: 'ev_snapshot_removed', deviceId, deviceName: previousEv.name });
  }
}

function getEvSnapshotEntries(snapshot: TransportDeviceSnapshot[]): Map<string, TransportDeviceSnapshot> {
  return new Map(
    snapshot
      .filter((device) => device.deviceClass === 'evcharger')
      .map((device) => [device.id, device]),
  );
}

function buildEvSnapshotChangeLines(
  previousEv: TransportDeviceSnapshot,
  nextEv: TransportDeviceSnapshot,
): string[] {
  const changes: string[] = [];
  const previousOn = resolveBinaryOn(previousEv);
  const nextOn = resolveBinaryOn(nextEv);
  if (previousOn !== nextOn) {
    changes.push(`currentOn ${String(previousOn)} -> ${String(nextOn)}`);
  }
  if (previousEv.evChargingState !== nextEv.evChargingState) {
    changes.push(`evState ${previousEv.evChargingState ?? 'unknown'} -> ${nextEv.evChargingState ?? 'unknown'}`);
  }
  if (previousEv.available !== nextEv.available) {
    changes.push(`available ${String(previousEv.available !== false)} -> ${String(nextEv.available !== false)}`);
  }
  if (previousEv.binaryCapabilityId !== nextEv.binaryCapabilityId) {
    changes.push(
      `control ${previousEv.binaryCapabilityId ?? 'unknown'} `
      + `-> ${nextEv.binaryCapabilityId ?? 'unknown'}`,
    );
  }
  if (previousEv.expectedPowerKw !== nextEv.expectedPowerKw) {
    changes.push(`expectedPowerKw ${previousEv.expectedPowerKw} -> ${nextEv.expectedPowerKw}`);
  }
  return changes;
}

function formatEvSnapshotDiscovery(snapshot: TransportDeviceSnapshot): string {
  return [
    `currentOn=${String(resolveBinaryOn(snapshot))}`,
    `evState=${snapshot.evChargingState ?? 'unknown'}`,
    `available=${snapshot.available !== false}`,
    `expectedPowerKw=${snapshot.expectedPowerKw}`,
    `control=${snapshot.binaryCapabilityId ?? 'unknown'}`,
  ].join(', ');
}

function formatEvSnapshotDetails(
  snapshot: TransportDeviceSnapshot | undefined,
  includePower: boolean,
): string {
  const details = [
    `currentOn=${String(snapshot ? resolveBinaryOn(snapshot) : true)}`,
    `evState=${snapshot?.evChargingState ?? 'unknown'}`,
  ];
  if (includePower) {
    details.push(`available=${snapshot?.available !== false}`);
    details.push(`expectedPowerKw=${snapshot?.expectedPowerKw ?? 'unknown'}`);
  }
  return details.join(', ');
}
