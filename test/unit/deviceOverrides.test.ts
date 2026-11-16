import {
  endDeviceOverride, readActiveDeviceOverride, readActiveTemperatureOverride, startDeviceOverride,
} from '../../lib/overrides/deviceOverrides';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';

const NOW_MS = Date.UTC(2026, 10, 16, 12);
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

const createSettings = (initial: Record<string, unknown> = {}): SettingsPort & { store: Map<string, unknown> } => {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value); },
    unset: (key) => { store.delete(key); },
    getKeys: () => [...store.keys()],
  };
};

const temperature = (targetC: number) => ({ type: 'temperature' as const, targetC });

describe('device overrides', () => {
  it('is in force until its end time and inert from then on', () => {
    const settings = createSettings();
    expect(startDeviceOverride(settings, 'heater', { setting: temperature(23), minutes: 90 }, NOW_MS)).toBe('written');

    expect(settings.store.get('device_override.heater')).toEqual({
      untilMs: NOW_MS + 90 * 60_000, setting: temperature(23),
    });
    expect(readActiveTemperatureOverride(settings, 'heater', NOW_MS + 89 * 60_000))
      .toEqual({ targetC: 23, untilMs: NOW_MS + 90 * 60_000 });
    expect(readActiveDeviceOverride(settings, 'heater', NOW_MS + 90 * 60_000)).toBeNull();
    expect(readActiveDeviceOverride(settings, 'other', NOW_MS)).toBeNull();
  });

  it('replaces the device\'s override when another is started', () => {
    const settings = createSettings();
    startDeviceOverride(settings, 'heater', { setting: temperature(23), minutes: 90 }, NOW_MS);
    startDeviceOverride(settings, 'heater', { setting: temperature(19), minutes: 30 }, NOW_MS + HOUR_MS);

    expect(readActiveTemperatureOverride(settings, 'heater', NOW_MS + HOUR_MS))
      .toEqual({ targetC: 19, untilMs: NOW_MS + 90 * 60_000 });
  });

  it('ends early by storing an end time of now', () => {
    const settings = createSettings();
    startDeviceOverride(settings, 'heater', { setting: temperature(23), minutes: 90 }, NOW_MS);

    expect(endDeviceOverride(settings, 'heater', NOW_MS + HOUR_MS)).toBe('written');
    expect(readActiveDeviceOverride(settings, 'heater', NOW_MS + HOUR_MS)).toBeNull();
    expect(endDeviceOverride(settings, 'heater', NOW_MS + HOUR_MS)).toBe('unchanged');
  });

  it('accepts an end time up to seven days ahead, as the settings UI may write', () => {
    const settings = createSettings({
      'device_override.week': { untilMs: NOW_MS + 7 * DAY_MS, setting: temperature(22) },
      'device_override.longer': { untilMs: NOW_MS + 7 * DAY_MS + 1, setting: temperature(22) },
    });

    expect(readActiveTemperatureOverride(settings, 'week', NOW_MS)?.targetC).toBe(22);
    expect(readActiveDeviceOverride(settings, 'longer', NOW_MS)).toBeNull();
  });

  it.each([
    ['a missing setting', { untilMs: NOW_MS + HOUR_MS }],
    ['an unknown kind', { untilMs: NOW_MS + HOUR_MS, setting: { type: 'fan', speed: 2 } }],
    ['a temperature that is not a number', { untilMs: NOW_MS + HOUR_MS, setting: { type: 'temperature', targetC: 'warm' } }],
    ['an end time that is not finite', { untilMs: Number.NaN, setting: temperature(22) }],
    ['a value that is not an object', 'on'],
  ])('reads %s as no override', (_label, stored) => {
    expect(readActiveDeviceOverride(createSettings({ 'device_override.heater': stored }), 'heater', NOW_MS)).toBeNull();
  });

  it('reads no override when the settings read throws', () => {
    const settings = createSettings();
    settings.get = () => { throw new Error('settings unavailable'); };

    expect(readActiveDeviceOverride(settings, 'heater', NOW_MS)).toBeNull();
    expect(startDeviceOverride(settings, 'heater', { setting: temperature(23), minutes: 30 }, NOW_MS)).toBe('unavailable');
  });

  it('refuses a temperature on a device set to Keep the new temperature', () => {
    const settings = createSettings({ temperature_control_modes: { heater: 'external' } });

    expect(startDeviceOverride(settings, 'heater', { setting: temperature(23), minutes: 30 }, NOW_MS))
      .toBe('temperature_control_off');
    expect(settings.store.has('device_override.heater')).toBe(false);
  });

  it('is not in force as a temperature while the device is set to Keep the new temperature', () => {
    const settings = createSettings({
      'device_override.heater': { untilMs: NOW_MS + HOUR_MS, setting: temperature(23) },
    });
    expect(readActiveTemperatureOverride(settings, 'heater', NOW_MS)?.targetC).toBe(23);

    settings.set('temperature_control_modes', { heater: 'external' });
    expect(readActiveTemperatureOverride(settings, 'heater', NOW_MS)).toBeNull();
  });

  it('removes a key a day after its override ended, and keeps the rest', () => {
    const settings = createSettings({
      'device_override.old': { untilMs: NOW_MS - DAY_MS, setting: temperature(18) },
      'device_override.recent': { untilMs: NOW_MS - HOUR_MS, setting: temperature(18) },
      'device_override.running': { untilMs: NOW_MS + HOUR_MS, setting: temperature(18) },
    });

    startDeviceOverride(settings, 'heater', { setting: temperature(23), minutes: 30 }, NOW_MS);

    expect([...settings.store.keys()].sort()).toEqual([
      'device_override.heater', 'device_override.recent', 'device_override.running',
    ]);
  });

  describe('a temporary temperature stored by an earlier version', () => {
    const legacy = { temporary_temperature_targets: { heater: { targetC: 24, untilMs: NOW_MS + HOUR_MS } } };

    it('still counts until it ends', () => {
      const settings = createSettings(legacy);

      expect(readActiveTemperatureOverride(settings, 'heater', NOW_MS)).toEqual({ targetC: 24, untilMs: NOW_MS + HOUR_MS });
      expect(readActiveDeviceOverride(settings, 'heater', NOW_MS + HOUR_MS)).toBeNull();
    });

    it('gives way to the device\'s own key, including one that ended it', () => {
      const settings = createSettings(legacy);

      expect(endDeviceOverride(settings, 'heater', NOW_MS)).toBe('written');
      expect(readActiveDeviceOverride(settings, 'heater', NOW_MS)).toBeNull();

      startDeviceOverride(settings, 'heater', { setting: temperature(20), minutes: 10 }, NOW_MS);
      expect(readActiveTemperatureOverride(settings, 'heater', NOW_MS)?.targetC).toBe(20);
    });
  });
});
