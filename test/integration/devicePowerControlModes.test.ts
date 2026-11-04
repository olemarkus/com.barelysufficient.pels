import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import {
  DEVICE_POWER_CONTROL_MODES, DEVICE_TARGET_POWER_CONFIGS, DEVICE_CONTROL_PROFILES, NATIVE_EV_WIRING_DEVICES,
} from '../../lib/utils/settingsKeys';

function fixture(entries: [string, unknown][] = []) {
  const values = new Map(entries);
  const settings = new DeviceControlSettings({
    get: (key) => values.get(key) ?? null,
    getKeys: () => [...values.keys()],
  });
  settings.reload();
  return { settings, values };
}

describe('device power-control choice', () => {
  it('uses Automatic for an unconfigured device and Manual for an existing current setup', () => {
    const { settings } = fixture();
    expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('automatic');
    expect(settings.resolveDevicePowerControlMode('charger', true)).toBe('manual');
  });

  it.each([
    { enabled: true, preset: 'ev_charger_3_phase' },
    { enabled: true, min: 0, max: 4000, step: 500 },
    { enabled: false },
  ])('keeps the authored model %j in Manual until an explicit choice', (config) => {
    const { settings, values } = fixture([[DEVICE_TARGET_POWER_CONFIGS, { charger: config }]]);
    expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('manual');
    values.set(DEVICE_POWER_CONTROL_MODES, { charger: 'automatic' });
    settings.reload();
    expect(settings.resolveDevicePowerControlMode('charger', true)).toBe('automatic');
    expect(values.get(DEVICE_TARGET_POWER_CONFIGS)).toEqual({ charger: config });
    values.set(DEVICE_POWER_CONTROL_MODES, { charger: 'manual' });
    settings.reload();
    expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('manual');
  });

  it('keeps an existing Flow ladder in Manual', () => {
    const { settings } = fixture([[DEVICE_CONTROL_PROFILES, { charger: {
      controlModel: 'stepped_load', steps: [{ id: 'off', planningPowerW: 0 }, { id: 'low', planningPowerW: 2000 }],
    } }]]);
    expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('manual');
  });

  it.each([false, true])('preserves an existing native-control choice %s until Automatic is selected', (enabled) => {
    const { settings, values } = fixture([[NATIVE_EV_WIRING_DEVICES, { charger: enabled }]]);
    expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('manual');
    values.set(DEVICE_POWER_CONTROL_MODES, { charger: 'automatic' });
    settings.reload();
    expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('automatic');
    expect(values.get(NATIVE_EV_WIRING_DEVICES)).toEqual({ charger: enabled });
  });

  it.each([null, { charger: 'other' }, 42])('does not treat an unreadable saved choice %j as Automatic', (raw) => {
    const { settings, values } = fixture([[DEVICE_POWER_CONTROL_MODES, raw]]);
    expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('manual');
    values.set(DEVICE_POWER_CONTROL_MODES, { charger: 'automatic' });
    settings.reload();
    expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('automatic');
    values.set(DEVICE_POWER_CONTROL_MODES, null);
    settings.reload();
    expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('automatic');
  });

  it.each([DEVICE_TARGET_POWER_CONFIGS, DEVICE_CONTROL_PROFILES, NATIVE_EV_WIRING_DEVICES])(
    'waits for the legacy %s read before inferring an Automatic default', (key) => {
      const { settings, values } = fixture([[key, null]]);
      expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('manual');
      values.set(key, {});
      settings.reload();
      expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('automatic');
      values.set(key, null);
      settings.reload();
      expect(settings.resolveDevicePowerControlMode('charger', false)).toBe('automatic');
    },
  );
});
