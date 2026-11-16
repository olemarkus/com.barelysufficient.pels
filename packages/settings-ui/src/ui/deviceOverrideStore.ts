import {
  DEVICE_OVERRIDE_PREFIX, deviceOverrideKey, isDeviceOverrideInForce, isDeviceOverrideKey, parseDeviceOverride,
  type DeviceOverride,
} from '../../../shared-domain/src/settings/deviceOverrides.ts';
import { getSetting, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';

/**
 * The stored override of each device the settings UI has looked at, read from
 * and written to its `device_override.<deviceId>` key. The Override card and
 * the Smart task surfaces read it from here; `device-override-changed` tells
 * them when a device's entry was read, written or changed elsewhere.
 */
export const DEVICE_OVERRIDE_CHANGED_EVENT = 'device-override-changed';

// `null` is a device read with nothing stored; a missing entry was never read.
const stored = new Map<string, DeviceOverride | null>();
const reads = new Map<string, number>();

const remember = (deviceId: string, override: DeviceOverride | null): void => {
  stored.set(deviceId, override);
  document.dispatchEvent(new CustomEvent(DEVICE_OVERRIDE_CHANGED_EVENT, { detail: { deviceId } }));
};

/** Read the device's stored override; the latest read of a device wins. */
export const loadDeviceOverride = async (deviceId: string): Promise<void> => {
  const generation = (reads.get(deviceId) ?? 0) + 1;
  reads.set(deviceId, generation);
  let override: DeviceOverride | null = null;
  try {
    override = parseDeviceOverride(await getSetting(deviceOverrideKey(deviceId)));
  } catch (error) {
    void logSettingsError('Failed to read device override', error, 'device override');
  }
  if (reads.get(deviceId) === generation) remember(deviceId, override);
};

/** Read the device's override unless the UI already has it. */
export const primeDeviceOverride = (deviceId: string): void => {
  if (!stored.has(deviceId) && !reads.has(deviceId)) void loadDeviceOverride(deviceId);
};

export const hasLoadedDeviceOverride = (deviceId: string): boolean => stored.has(deviceId);

/** The device's override while it is in force, as far as the UI has read it. */
export const getActiveDeviceOverride = (deviceId: string, nowMs: number): DeviceOverride | null => {
  const override = stored.get(deviceId) ?? null;
  return override !== null && isDeviceOverrideInForce(override, nowMs) ? override : null;
};

export const saveDeviceOverride = async (deviceId: string, override: DeviceOverride): Promise<void> => {
  await setSetting(deviceOverrideKey(deviceId), override);
  reads.set(deviceId, (reads.get(deviceId) ?? 0) + 1);
  remember(deviceId, override);
};

/** A Flow or another session changed an override the UI has looked at. */
export const notifyDeviceOverrideSettingChanged = (key: string): void => {
  if (!isDeviceOverrideKey(key)) return;
  const deviceId = key.slice(DEVICE_OVERRIDE_PREFIX.length);
  if (stored.has(deviceId)) void loadDeviceOverride(deviceId);
};
