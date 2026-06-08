import type { EvChargingState, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
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
  controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
}): boolean | undefined {
  const { deviceClassKey, capabilityObj, controlCapabilityId } = params;
  if (controlCapabilityId === 'evcharger_charging' || deviceClassKey === 'evcharger') {
    return resolveEvCurrentOnObservation({
      evChargingState: getEvChargingState(capabilityObj),
      evchargerCharging: getEvCharging(capabilityObj),
    });
  }
  if (typeof capabilityObj.onoff?.value === 'boolean') {
    return capabilityObj.onoff.value;
  }
  return undefined;
}

export function resolveEvCurrentOn(params: {
  evChargingState: EvChargingState | undefined;
  evchargerCharging: unknown;
}): boolean {
  const { evChargingState, evchargerCharging } = params;
  // The charge-state string is authoritative (Homey requires both EV
  // capabilities on a charger). `currentOn` = "free to draw": only
  // `plugged_in_charging` is on; a paused charger is held off — commandable,
  // but NOT on, exactly like a binary device with onoff=false. The raw
  // `evcharger_charging` boolean is consulted only as a fallback when the state
  // string is absent (a transient pull gap), so a boolean lingering `true`
  // during a pause cannot contradict the state.
  if (evChargingState !== undefined) {
    return evChargingState === 'plugged_in_charging';
  }
  if (evchargerCharging === true) {
    return true;
  }
  if (evchargerCharging === false) {
    return false;
  }
  return true;
}

export function resolveEvCurrentOnObservation(params: {
  evChargingState: EvChargingState | undefined;
  evchargerCharging: unknown;
}): boolean | undefined {
  const { evChargingState, evchargerCharging } = params;
  // State-authoritative (see resolveEvCurrentOn): the charge-state string wins
  // when present; the raw boolean is only a transient state-missing fallback,
  // and `undefined` defers to the previous-snapshot synthesis upstream.
  if (evChargingState !== undefined) {
    return resolveEvCurrentOn({ evChargingState, evchargerCharging });
  }
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

// Membership set derived from a `satisfies Record<EvChargingState, …>` literal so
// a new union member is a compile error here until it's added to the guard (the
// Set keeps `has` off the prototype chain — `'toString' in record` would lie).
const EV_CHARGING_STATES: ReadonlySet<string> = new Set(
  Object.keys({
    plugged_in_charging: 0,
    plugged_in: 0,
    plugged_in_paused: 0,
    plugged_out: 0,
    plugged_in_discharging: 0,
  } satisfies Record<EvChargingState, 0>),
);

export function isEvChargingState(value: unknown): value is EvChargingState {
  return typeof value === 'string' && EV_CHARGING_STATES.has(value);
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
  previousSnapshot: TargetDeviceSnapshot[];
  nextSnapshot: TargetDeviceSnapshot[];
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
    `currentOn=${String(resolveBinaryOn(snapshot))}`,
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
    `currentOn=${String(snapshot ? resolveBinaryOn(snapshot) : true)}`,
    `evState=${snapshot?.evChargingState ?? 'unknown'}`,
  ];
  if (includePower) {
    details.push(`available=${snapshot?.available !== false}`);
    details.push(`powerKw=${snapshot?.powerKw ?? snapshot?.measuredPowerKw ?? 'unknown'}`);
  }
  return details.join(', ');
}
