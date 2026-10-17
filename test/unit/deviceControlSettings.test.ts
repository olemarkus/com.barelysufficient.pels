import { describe, expect, it } from 'vitest';
import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import { buildTargetPowerReachabilityState } from '../../lib/device/targetPowerReachability';
import {
  DEVICE_DRIVER_OVERRIDES,
  EV_CAR_ASSOCIATIONS,
  MANAGED_DEVICES,
  TEMPERATURE_BOOST_SETTINGS,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_TARGET_POWER_REACHABILITY,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
} from '../../lib/utils/settingsKeys';

/**
 * A settings double whose values the spec can change between reads, so the
 * last-good cases establish a held map with one read and then fail the next.
 * An unset key answers `null`, as the SDK does.
 */
const settingsDouble = (initial: Record<string, unknown> = {}, keys?: string[]) => {
  const values: Record<string, unknown> = { ...initial };
  const port = {
    throwOn: undefined as string | undefined,
    get: (key: string): unknown => {
      if (key === port.throwOn) throw new Error('settings unavailable');
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    getKeys: (): string[] => keys ?? Object.keys(values),
  };
  return { port, values };
};

const loaded = (port: ConstructorParameters<typeof DeviceControlSettings>[0]): DeviceControlSettings => {
  const settings = new DeviceControlSettings(port);
  settings.reload();
  return settings;
};

const temperatureDevice = { deviceType: 'temperature' as const };

describe('DeviceControlSettings managed filter', () => {
  it('reports inactive for an empty managed map', () => {
    expect(loaded(settingsDouble({ [MANAGED_DEVICES]: {} }).port).isManagedFilterActive()).toBe(false);
  });

  it('reports inactive for an all-false managed map', () => {
    // Explicit opt-outs alone must not switch the runtime to the explicit-only
    // managed set; devices with no key remain implicitly managed.
    const settings = loaded(settingsDouble({ [MANAGED_DEVICES]: { 'vt-1': false, 'socket-1': false } }).port);
    expect(settings.isManagedFilterActive()).toBe(false);
  });

  it('reports active when at least one device is explicitly enabled', () => {
    expect(loaded(settingsDouble({ [MANAGED_DEVICES]: { ev1: true } }).port).isManagedFilterActive()).toBe(true);
    expect(loaded(settingsDouble({ [MANAGED_DEVICES]: { ev1: true, 'vt-1': false } }).port).isManagedFilterActive())
      .toBe(true);
  });
});

describe('DeviceControlSettings temperature-command policy', () => {
  it('loads the temperature-control disabled device map', () => {
    const { port } = settingsDouble({ [TEMPERATURE_CONTROL_DISABLED_DEVICES]: { thermostat: true, heater: false } });
    const settings = loaded(port);

    expect(settings.temperatureControlPolicyState).toBe('resolved');
    expect(settings.isTemperatureControlDisabled('thermostat', temperatureDevice)).toBe(true);
    expect(settings.isTemperatureControlDisabled('heater', temperatureDevice)).toBe(false);
  });

  it('resolves a genuinely absent fresh-install setting as an empty policy', () => {
    // `null` is what the SDK answers for a key that was never written.
    const { port } = settingsDouble({}, ['some_other_setting']);
    const settings = loaded(port);

    expect(settings.temperatureControlPolicyState).toBe('resolved');
    expect(settings.isTemperatureControlDisabled('thermostat', temperatureDevice)).toBe(false);
  });

  it('fails closed when the key is present but its value is unavailable', () => {
    const { port } = settingsDouble({}, [TEMPERATURE_CONTROL_DISABLED_DEVICES]);
    const settings = loaded(port);

    expect(settings.temperatureControlPolicyState).toBe('unavailable');
    expect(settings.isTemperatureControlDisabled('thermostat', temperatureDevice)).toBe(true);
  });

  it('fails closed when an empty key list cannot prove fresh-install absence', () => {
    const { port } = settingsDouble({}, []);
    const settings = loaded(port);

    expect(settings.temperatureControlPolicyState).toBe('unavailable');
  });

  it('recovers an unavailable cold-boot policy after a later valid read', () => {
    const { port, values } = settingsDouble({ [TEMPERATURE_CONTROL_DISABLED_DEVICES]: { thermostat: 'invalid' } });
    const settings = loaded(port);
    expect(settings.temperatureControlPolicyState).toBe('unavailable');

    values[TEMPERATURE_CONTROL_DISABLED_DEVICES] = { thermostat: true };
    settings.reload();

    expect(settings.temperatureControlPolicyState).toBe('resolved');
    expect(settings.isTemperatureControlDisabled('thermostat', temperatureDevice)).toBe(true);
  });

  it('retries an unavailable policy at command-authority read time', () => {
    const { port, values } = settingsDouble({ [TEMPERATURE_CONTROL_DISABLED_DEVICES]: { thermostat: 'invalid' } });
    const settings = loaded(port);

    expect(settings.isTemperatureControlDisabled('thermostat', temperatureDevice)).toBe(true);
    expect(settings.temperatureControlPolicyState).toBe('unavailable');

    values[TEMPERATURE_CONTROL_DISABLED_DEVICES] = {};
    expect(settings.isTemperatureControlDisabled('thermostat', temperatureDevice)).toBe(false);
    expect(settings.temperatureControlPolicyState).toBe('resolved');
  });

  it('keeps the last-good temperature-control map when persisted data is invalid', () => {
    const { port, values } = settingsDouble({ [TEMPERATURE_CONTROL_DISABLED_DEVICES]: { thermostat: true } });
    const settings = loaded(port);

    values[TEMPERATURE_CONTROL_DISABLED_DEVICES] = { thermostat: 'yes' };
    settings.reload();

    expect(settings.temperatureControlPolicyState).toBe('resolved');
    expect(settings.isTemperatureControlDisabled('thermostat', temperatureDevice)).toBe(true);
  });

  it('keeps the last-good temperature-control map when the settings read throws', () => {
    const { port } = settingsDouble({ [TEMPERATURE_CONTROL_DISABLED_DEVICES]: { thermostat: true } });
    const settings = loaded(port);

    port.throwOn = TEMPERATURE_CONTROL_DISABLED_DEVICES;
    settings.reload();

    expect(settings.temperatureControlPolicyState).toBe('resolved');
    expect(settings.isTemperatureControlDisabled('thermostat', temperatureDevice)).toBe(true);
  });
});

describe('DeviceControlSettings device overrides and target power configs', () => {
  it('loads normalized device driver overrides from settings', () => {
    const { port } = settingsDouble({
      [DEVICE_DRIVER_OVERRIDES]: {
        ' 0528ae3e-1289-49db-8fb4-624c32592745 ': ' homey:app:com.zaptec:go2 ',
        empty: '   ',
        '   ': 'homey:app:com.zaptec:go',
      },
    });
    const settings = loaded(port);

    expect(settings.getDeviceDriverIdOverride('0528ae3e-1289-49db-8fb4-624c32592745'))
      .toBe('homey:app:com.zaptec:go2');
    expect(settings.getDeviceDriverIdOverride('empty')).toBeUndefined();
  });

  it('keeps current device driver overrides when settings payload is invalid', () => {
    const { port, values } = settingsDouble({ [DEVICE_DRIVER_OVERRIDES]: { device: 'homey:app:com.zaptec:go2' } });
    const settings = loaded(port);

    values[DEVICE_DRIVER_OVERRIDES] = { device: 123 };
    settings.reload();

    expect(settings.getDeviceDriverIdOverride('device')).toBe('homey:app:com.zaptec:go2');
  });

  it('loads normalized target power configs from settings', () => {
    const { port } = settingsDouble({
      [DEVICE_TARGET_POWER_CONFIGS]: {
        ' device-a ': JSON.stringify({
          preset: 'ev_charger_1_phase',
          min: 0,
          max: 7360,
          step: 460,
          excludeMin: 1,
          excludeMax: 1380,
        }),
      },
    });

    expect(loaded(port).deviceTargetPowerConfigs).toEqual({
      'device-a': {
        preset: 'ev_charger_1_phase',
        min: 0,
        max: 7360,
        step: 460,
        excludeMin: 1,
        excludeMax: 1380,
      },
    });
  });

  it('keeps valid target power configs when stale entries are present', () => {
    const { port, values } = settingsDouble({
      [DEVICE_TARGET_POWER_CONFIGS]: { old: { enabled: true, preset: 'ev_charger_1_phase' } },
    });
    const settings = loaded(port);

    values[DEVICE_TARGET_POWER_CONFIGS] = {
      charger: { enabled: true, preset: 'ev_charger_3_phase' },
      stale: null,
    };
    settings.reload();

    expect(settings.deviceTargetPowerConfigs).toEqual({
      charger: { enabled: true, preset: 'ev_charger_3_phase' },
    });
  });

  it('joins compatible runtime-owned reachability into user-authored configs', () => {
    const config = {
      enabled: true,
      preset: 'ev_charger_1_phase' as const,
      min: 0,
      max: 7_360,
      step: 460,
      excludeMin: 1,
      excludeMax: 1_380,
    };
    const reachability = buildTargetPowerReachabilityState({
      config,
      maxReachedPowerW: 5_750,
      probeFailureCount: 1,
      nextProbeAtMs: 900_000,
    });
    const { port } = settingsDouble({
      [DEVICE_TARGET_POWER_CONFIGS]: { charger: config },
      [DEVICE_TARGET_POWER_REACHABILITY]: { charger: reachability },
    });

    expect(loaded(port).getDeviceTargetPowerConfig('charger')?.reachability).toStrictEqual(reachability);
  });

  it('keeps newer in-memory reachability ahead of a stale valid persisted map', () => {
    const config = {
      enabled: true,
      preset: 'ev_charger_1_phase' as const,
      max: 7_360,
    };
    const stale = buildTargetPowerReachabilityState({
      config,
      maxReachedPowerW: 5_520,
    });
    const current = buildTargetPowerReachabilityState({
      config,
      maxReachedPowerW: 5_750,
      probeFailureCount: 1,
      nextProbeAtMs: 900_000,
    });
    const { port } = settingsDouble({
      [DEVICE_TARGET_POWER_CONFIGS]: { charger: config },
      [DEVICE_TARGET_POWER_REACHABILITY]: { charger: stale },
    });
    const settings = loaded(port);
    settings.adoptTargetPowerReachability('charger', current!);
    settings.reload();

    expect(settings.getDeviceTargetPowerConfig('charger')?.reachability).toStrictEqual(current);
  });

  it('rejects a reachability map with any malformed sibling', () => {
    const config = {
      enabled: true,
      preset: 'ev_charger_1_phase' as const,
      max: 7_360,
    };
    const reachability = buildTargetPowerReachabilityState({
      config,
      maxReachedPowerW: 5_750,
    });
    const { port } = settingsDouble({
      [DEVICE_TARGET_POWER_CONFIGS]: { charger: config },
      [DEVICE_TARGET_POWER_REACHABILITY]: { charger: reachability, sibling: { maxReachedPowerW: 'bad' } },
    });

    expect(loaded(port).getDeviceTargetPowerConfig('charger')).toEqual(config);
  });

  it('keeps current target power configs when persisted payload is malformed JSON', () => {
    const { port, values } = settingsDouble({
      [DEVICE_TARGET_POWER_CONFIGS]: { charger: { enabled: true, preset: 'ev_charger_1_phase' } },
    });
    const settings = loaded(port);

    values[DEVICE_TARGET_POWER_CONFIGS] = '{"charger":{"enabled":true,"preset":"ev_charger_3_phase"';
    settings.reload();

    expect(settings.deviceTargetPowerConfigs).toEqual({
      charger: { enabled: true, preset: 'ev_charger_1_phase' },
    });
  });
});

describe('DeviceControlSettings reload generations', () => {
  it('keeps the whole previous generation when a later read throws', () => {
    const { port, values } = settingsDouble({
      [MANAGED_DEVICES]: { heater: true },
      [DEVICE_DRIVER_OVERRIDES]: { heater: 'homey:app:com.example:old' },
    });
    const settings = loaded(port);

    values[MANAGED_DEVICES] = { heater: false, socket: true };
    port.throwOn = DEVICE_DRIVER_OVERRIDES;
    expect(() => settings.reload()).toThrow('settings unavailable');

    // The managed map was read before the throw, and is still not adopted.
    expect(settings.managedDevices).toEqual({ heater: true });
    expect(settings.getDeviceDriverIdOverride('heater')).toBe('homey:app:com.example:old');

    port.throwOn = undefined;
    settings.reload();
    expect(settings.managedDevices).toEqual({ heater: false, socket: true });
  });

  it('keeps the boost settings and car associations across a read that is not a map', () => {
    const { port, values } = settingsDouble({
      [TEMPERATURE_BOOST_SETTINGS]: { heater: { enabled: true, boostBelowC: 18 } },
      [EV_CAR_ASSOCIATIONS]: { charger: { carIds: ['car-1'] } },
    });
    const settings = loaded(port);

    delete values[TEMPERATURE_BOOST_SETTINGS];
    delete values[EV_CAR_ASSOCIATIONS];
    settings.reload();

    expect(settings.getTemperatureBoostConfig('heater')).toMatchObject({ boostBelowC: 18 });
    expect(settings.getEvCarAssociationCarIds('charger')).toEqual(['car-1']);
  });
});
