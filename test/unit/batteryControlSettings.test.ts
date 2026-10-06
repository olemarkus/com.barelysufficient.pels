import { describe, expect, it } from 'vitest';
import { readBatteryControlSettings } from '../../lib/battery/batteryControlSettings';
import {
  isBatteryControlEnabled,
  parseBatteryControlDevices,
} from '../../packages/shared-domain/src/settings/batteryControlDevices';
import { BatteryClaimStore } from '../../lib/battery/batteryClaimStore';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import { BATTERY_CONTROL_DEVICES, PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX } from '../../lib/utils/settingsKeys';

// A settings store as the SDK answers it: an unset key reads `null`, and the
// key list follows `set`/`unset`. `listed: false` models the empty-list flake.
const settingsStore = (initial: Record<string, unknown>, options: { listed?: boolean } = {}): SettingsPort => {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => (values.has(key) ? values.get(key) : null),
    set: (key, value) => { values.set(key, value); },
    unset: (key) => { values.delete(key); },
    getKeys: () => (options.listed === false ? [] : [...values.keys()]),
  };
};

describe('battery_control_devices', () => {
  it('reads a per-battery map and keeps only explicit false as an opt-out', () => {
    const devices = parseBatteryControlDevices({ a: false, b: true });
    expect(devices).toEqual({ a: false, b: true });
    expect(isBatteryControlEnabled(devices ?? {}, 'a')).toBe(false);
    expect(isBatteryControlEnabled(devices ?? {}, 'b')).toBe(true);
    expect(isBatteryControlEnabled(devices ?? {}, 'absent')).toBe(true);
  });

  it.each([null, [], 'on', { a: 'false' }, { a: false, b: 0 }, { '': false }])(
    'refuses %j whole rather than turning an opted-out battery back on',
    (value) => {
      expect(parseBatteryControlDevices(value)).toBeNull();
    },
  );

  it('reads a never-written key as every battery on, and a flake or junk as unknown', () => {
    expect(readBatteryControlSettings(settingsStore({ other: 1 }))).toEqual({ status: 'resolved', devices: {} });
    expect(readBatteryControlSettings(settingsStore({ [BATTERY_CONTROL_DEVICES]: { a: false } })))
      .toEqual({ status: 'resolved', devices: { a: false } });
    expect(readBatteryControlSettings(settingsStore({ [BATTERY_CONTROL_DEVICES]: { a: false } }, { listed: false })))
      .toEqual({ status: 'unavailable' });
    expect(readBatteryControlSettings(settingsStore({ [BATTERY_CONTROL_DEVICES]: 'junk' })))
      .toEqual({ status: 'unavailable' });
  });
});

describe('BatteryClaimStore', () => {
  const key = `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}battery-1`;

  it('stores, reads back and removes one record per battery', () => {
    const settings = settingsStore({ other: 1 });
    const store = new BatteryClaimStore(settings);
    const record = { capabilityId: 'target_power_mode', previousValue: 'anti_feed', claimedAtMs: 1_000 } as const;
    expect(store.write('battery-1', record)).toBe(true);
    expect(settings.get(key)).toEqual(record);
    const read = store.readAll();
    expect(read.status === 'resolved' ? Object.fromEntries(read.records) : read).toEqual({ 'battery-1': record });
    expect(store.remove('battery-1')).toBe(true);
    expect(settings.getKeys()).toEqual(['other']);
  });

  it('reports a record that does not parse for its own battery only, never as no record', () => {
    const good = { capabilityId: 'control_strategy', previousValue: 'POWER_STRATEGY_NOM', claimedAtMs: 5 };
    for (const junk of [{ capabilityId: 'onoff', previousValue: 'x', claimedAtMs: 1 }, true, {
      capabilityId: 'target_power_mode', previousValue: 'manual',
    }]) {
      const read = new BatteryClaimStore(settingsStore({
        [key]: junk,
        [`${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}battery-2`]: good,
      })).readAll();
      expect(read.status === 'resolved'
        ? { records: Object.fromEntries(read.records), unreadable: read.unreadableDeviceIds }
        : read).toEqual({ records: { 'battery-2': good }, unreadable: ['battery-1'] });
    }
    expect(new BatteryClaimStore(settingsStore({ other: 1 }, { listed: false })).readAll())
      .toEqual({ status: 'unavailable' });
  });

  it('reports a write the store refused, so the battery is not claimed', () => {
    const settings: SettingsPort = { ...settingsStore({}), set: () => { throw new Error('busy'); } };
    expect(new BatteryClaimStore(settings).write('battery-1', {
      capabilityId: 'control_strategy',
      previousValue: 'POWER_STRATEGY_NOM',
      claimedAtMs: 1,
    })).toBe(false);
  });
});
