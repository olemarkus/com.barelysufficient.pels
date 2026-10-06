/**
 * The `battery_control_devices` setting: one key, one runtime reader.
 *
 * The owner's Managed choice per home battery. A battery is managed by
 * default; the owner turns it off with an explicit `false`, and an absent
 * entry, or an absent key, means Managed is on. `true` is accepted and means
 * the same as absence, so the settings UI may write either. The parse is
 * shared with the settings UI's Managed toggle
 * (`packages/shared-domain/src/settings/batteryControlDevices.ts`).
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
import type { BatteryManagedRead } from '../ports/batteryControlOwner';
import {
  isBatteryControlEnabled,
  parseBatteryControlDevices,
  type BatteryControlDevices,
} from '../../packages/shared-domain/src/settings/batteryControlDevices';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { BATTERY_CONTROL_DEVICES } from '../utils/settingsKeys';

export type BatteryControlDevicesRead =
  | { status: 'resolved'; devices: BatteryControlDevices }
  | { status: 'unavailable' };

const NEVER_WRITTEN: BatteryControlDevices = {};

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

/**
 * The owner's Managed map as the runtime holds it, and the one Managed answer
 * for a home battery (`BatteryManagedRead`). Constructed at app start, before
 * the battery control owner exists, so the first device parse already reads
 * it; the owner delegates to it once it does.
 *
 * Fail closed, without forgetting: until the setting first reads cleanly every
 * battery reads unmanaged, and a later read that fails keeps the last map that
 * read cleanly. A transient settings miss must not turn a held battery
 * unmanaged and drop it out of the plan while PELS still holds it.
 */
export class BatteryManagedSettings implements BatteryManagedRead {
  private last: BatteryControlDevicesRead = { status: 'unavailable' };

  constructor(private readonly settings: SettingsPort) {}

  /**
   * Re-read the setting. Answers this read; a failed one leaves the held map
   * as it was.
   */
  reload(): BatteryControlDevicesRead {
    const read = readBatteryControlSettings(this.settings);
    if (read.status === 'resolved') this.last = read;
    return read;
  }

  /** The stored setting as it reads now, leaving the held map untouched. */
  readStored(): BatteryControlDevicesRead {
    return readBatteryControlSettings(this.settings);
  }

  /** The held map, read first if no read has resolved yet. */
  read(): BatteryControlDevicesRead {
    return this.last.status === 'resolved' ? this.last : this.reload();
  }

  isManaged(deviceId: string): boolean {
    const read = this.read();
    return read.status === 'resolved' && isBatteryControlEnabled(read.devices, deviceId);
  }
}
