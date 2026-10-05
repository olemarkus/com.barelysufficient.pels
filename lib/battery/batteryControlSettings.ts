/**
 * The `battery_control_devices` setting: one key, one reader.
 *
 * PELS controls a home battery it can drive (a `setpoint` control surface) by
 * default. The owner opts a battery out with an explicit `false`; an absent
 * entry, or an absent key, means control is on. `true` is accepted and means
 * the same as absence, so a settings UI may write either.
 *
 * A runtime-only key until the settings UI reads it, so it lives with its
 * owner here (`notes/settings-key-ownership.md`); the UI slice promotes the
 * parse to `packages/shared-domain` when it adds that second reader.
 *
 * The reader owns absence, which only the runtime can tell apart through
 * `getKeys()`:
 *
 * - key not listed: never written, so every battery is on;
 * - key listed and parsed: the owner's map;
 * - key list empty, unreadable, or a listed value that does not parse:
 *   `unavailable`. Not an answer about the owner's wish.
 */
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { BATTERY_CONTROL_DEVICES } from '../utils/settingsKeys';

/** Per-battery control, keyed by device id. Absent = on; `false` = the owner opted out. */
export type BatteryControlDevices = Readonly<Record<string, boolean>>;

export type BatteryControlDevicesRead =
  | { status: 'resolved'; devices: BatteryControlDevices }
  | { status: 'unavailable' };

const NEVER_WRITTEN: BatteryControlDevices = {};

/**
 * Read policy: all or nothing, like every other per-device boolean map PELS
 * persists. A flat boolean has no partial state to repair, so a map with any
 * non-boolean entry is refused whole rather than sanitized: dropping one entry
 * would silently turn an opted-out battery back on. `null` is a rejected read,
 * never an empty map.
 */
export const parseBatteryControlDevices = (value: unknown): BatteryControlDevices | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([deviceId, enabled]) => deviceId.length > 0 && typeof enabled === 'boolean')) return null;
  return Object.fromEntries(entries);
};

/** Whether PELS may control this battery: on unless the owner opted it out. */
export const isBatteryControlEnabled = (devices: BatteryControlDevices, deviceId: string): boolean => (
  devices[deviceId] !== false
);

export const readBatteryControlSettings = (settings: SettingsPort): BatteryControlDevicesRead => {
  const keyList = readSettingsKeyList(settings);
  if (keyList.status !== 'resolved') return keyList;
  if (!keyList.keys.includes(BATTERY_CONTROL_DEVICES)) return { status: 'resolved', devices: NEVER_WRITTEN };
  try {
    const devices = parseBatteryControlDevices(settings.get(BATTERY_CONTROL_DEVICES));
    return devices === null ? { status: 'unavailable' } : { status: 'resolved', devices };
  } catch {
    return { status: 'unavailable' };
  }
};
