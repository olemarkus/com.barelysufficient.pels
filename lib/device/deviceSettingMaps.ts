import type { TargetPowerSteppedLoadConfig } from '../../packages/contracts/src/types';
import type { SettingsPort } from '../ports/homeyRuntime';
import { isBooleanMap } from '../utils/appTypeGuards';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import {
  BUDGET_EXEMPT_DEVICES,
  CONTROLLABLE_DEVICES,
  DEVICE_TARGET_POWER_CONFIGS,
} from '../utils/settingsKeys';
import { readDeviceTargetPowerConfigsRecord } from '../utils/targetPowerConfig';

/**
 * One device's entry in a per-device settings map, saved without touching any
 * other device's entry.
 *
 * Each of these maps is one settings document, so saving an entry is a
 * read-modify-write, and the read has to answer for the whole map first. A map
 * built from a read that failed holds only the device being saved, and writing
 * it erases every other device's entry. So absence is the key list's answer
 * (`readSettingsKeyList`): a key never written starts empty, while a listed key
 * that reads nullish or malformed, an empty or unreadable key list, or a throw
 * is `unavailable`, and nothing is written (`notes/persisted-settings-state.md`).
 * The caller turns `unavailable` into a visible failure, never a silent success.
 */
export type DeviceSettingMapWrite = 'written' | 'unavailable';

/** The per-device on/off maps a Flow card sets one device's entry in. */
export type DeviceFlagSettingKey = typeof CONTROLLABLE_DEVICES | typeof BUDGET_EXEMPT_DEVICES;

type DeviceSettingMapRead<T> =
  | { status: 'resolved'; entries: Readonly<Record<string, T>> }
  | { status: 'unavailable' };

const readDeviceSettingMap = <T>(
  settings: SettingsPort,
  key: string,
  parse: (raw: unknown) => Record<string, T> | undefined,
): DeviceSettingMapRead<T> => {
  try {
    const raw = settings.get(key);
    if (raw !== null && raw !== undefined) {
      const entries = parse(raw);
      return entries ? { status: 'resolved', entries } : { status: 'unavailable' };
    }
    const keyList = readSettingsKeyList(settings);
    return keyList.status === 'resolved' && !keyList.keys.includes(key)
      ? { status: 'resolved', entries: {} }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
};

/**
 * Set one device's entry in `controllable_devices` or `budget_exempt_devices`.
 * The stored map is read all-or-nothing, as the runtime loads it: an entry that
 * is not a boolean makes the whole map unreadable, not one to sanitize.
 */
export const writeDeviceFlagSetting = (
  settings: SettingsPort,
  key: DeviceFlagSettingKey,
  deviceId: string,
  enabled: boolean,
): DeviceSettingMapWrite => {
  const read = readDeviceSettingMap(settings, key, (raw) => (isBooleanMap(raw) ? raw : undefined));
  if (read.status === 'unavailable') return 'unavailable';
  settings.set(key, { ...read.entries, [deviceId]: enabled });
  return 'written';
};

/**
 * Save one device's config in `device_target_power_configs`. Stored entries
 * that are not stepped control are dropped on the way, as the boot repair
 * (`setup/steppedProfileRepair.ts`) drops them.
 */
export const writeDeviceTargetPowerConfig = (
  settings: SettingsPort,
  deviceId: string,
  config: TargetPowerSteppedLoadConfig,
): DeviceSettingMapWrite => {
  const read = readDeviceSettingMap(settings, DEVICE_TARGET_POWER_CONFIGS, readDeviceTargetPowerConfigsRecord);
  if (read.status === 'unavailable') return 'unavailable';
  settings.set(DEVICE_TARGET_POWER_CONFIGS, { ...read.entries, [deviceId]: config });
  return 'written';
};
