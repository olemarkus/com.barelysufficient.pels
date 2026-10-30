import type Homey from 'homey';
import {
  isPlausibleDeviceHomeAssignmentsBlob,
  normalizeDeviceHomeAssignments,
} from '../../lib/home/homeConfig';
import type { ModeTargetOwnershipRead } from '../../lib/home/modeOwnershipTransfer';
import {
  MODE_TARGET_OWNERSHIP_STATE,
  MODE_TARGET_OWNERSHIP_STATE_INITIALIZED,
  type HomeId,
} from '../../lib/utils/settingsKeys';
import { readSettingsKeyList } from '../../lib/utils/settingsKeyList';

// The port types are declared with the domain (`lib/home/modeOwnershipTransfer.ts`);
// this adapter re-exports them so existing importers keep their import site.
export type { ModeTargetOwnershipRead };

type SettingsReadResult = { value: unknown; threw: false } | { value: undefined; threw: true };

const readKey = (
  settings: Homey.App['homey']['settings'],
  key: string,
): SettingsReadResult => {
  try {
    return { value: settings.get(key) as unknown, threw: false };
  } catch {
    return { value: undefined, threw: true };
  }
};

const readMarker = (
  settings: Homey.App['homey']['settings'],
): SettingsReadResult => {
  try {
    return {
      value: settings.get(MODE_TARGET_OWNERSHIP_STATE_INITIALIZED) as unknown,
      threw: false,
    };
  } catch {
    return { value: undefined, threw: true };
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isPlausibleLedger = (value: unknown): value is Record<string, HomeId> => (
  isPlainRecord(value) && isPlausibleDeviceHomeAssignmentsBlob(value)
);

const writeBestEffort = (
  settings: Homey.App['homey']['settings'],
  key: string,
  value: Record<string, HomeId>,
): void => {
  try {
    settings.set(key, value);
  } catch {
    // A later read retries from the other durable copy.
  }
};

const isAbsent = (value: unknown): boolean => value === undefined || value === null;

/**
 * True unless the key list confirms none of these keys was written. An empty
 * list is an empty store; a thrown or malformed one confirms nothing.
 */
const hasAmbiguousMissingKey = (
  settings: Homey.App['homey']['settings'],
  keysToCheck: readonly string[],
): boolean => {
  const keyList = readSettingsKeyList(settings);
  return keyList.status === 'unavailable'
    || keysToCheck.some((key) => keyList.keys.includes(key));
};

const resolvePlausibleCopy = (params: {
  settings: Homey.App['homey']['settings'];
  raw: unknown;
  marker: unknown;
}): ModeTargetOwnershipRead | null => {
  const { settings, raw, marker } = params;
  if (isPlausibleLedger(marker)) {
    if (!isPlausibleLedger(raw)) {
      if (!isAbsent(raw)) return { state: 'suspect' };
      writeBestEffort(settings, MODE_TARGET_OWNERSHIP_STATE, marker);
    }
    return { state: 'present', owners: normalizeDeviceHomeAssignments(marker) };
  }
  if (!isPlausibleLedger(raw)) return null;
  if (!isAbsent(marker)) return { state: 'suspect' };
  if (hasAmbiguousMissingKey(settings, [MODE_TARGET_OWNERSHIP_STATE_INITIALIZED])) {
    return { state: 'suspect' };
  }
  writeBestEffort(settings, MODE_TARGET_OWNERSHIP_STATE_INITIALIZED, raw);
  return { state: 'present', owners: normalizeDeviceHomeAssignments(raw) };
};

/**
 * Settings adapter for the last owner whose mode target transfer completed.
 *
 * Reads distinguish `unwritten` from `suspect`; only the former grants the
 * one-time migration permission to seed from authoritative membership. The
 * marker stores the staged candidate, not just a boolean: writes establish it
 * first, so an interrupted value write can recover safely after restart.
 */
export class HomeModeOwnershipStore {
  constructor(private readonly settings: Homey.App['homey']['settings']) {}

  read(): ModeTargetOwnershipRead {
    try {
      const raw = readKey(this.settings, MODE_TARGET_OWNERSHIP_STATE);
      const marker = readMarker(this.settings);
      if (raw.threw || marker.threw) return { state: 'suspect' };
      const resolved = resolvePlausibleCopy({
        settings: this.settings,
        raw: raw.value,
        marker: marker.value,
      });
      if (resolved) return resolved;
      if (!isAbsent(raw.value) || !isAbsent(marker.value)) return { state: 'suspect' };
      if (hasAmbiguousMissingKey(this.settings, [
        MODE_TARGET_OWNERSHIP_STATE,
        MODE_TARGET_OWNERSHIP_STATE_INITIALIZED,
      ])) return { state: 'suspect' };
      return { state: 'unwritten' };
    } catch {
      return { state: 'suspect' };
    }
  }

  write(owners: ReadonlyMap<string, HomeId>): boolean {
    const value = Object.fromEntries(owners);
    if (!isPlausibleLedger(value)) return false;
    try {
      this.settings.set(MODE_TARGET_OWNERSHIP_STATE_INITIALIZED, value);
      this.settings.set(MODE_TARGET_OWNERSHIP_STATE, value);
      return true;
    } catch {
      return false;
    }
  }
}
