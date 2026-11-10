// The per-device temperature Flow cards, driven through their registered run and
// autocomplete listeners against the shared settings mock and a real Main mode
// catalog. Each card writes the setting its settings-UI field writes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerTemperatureSettingsCards } from '../../flowCards/temperatureSettingsCards';
import type { FlowCardDeps } from '../../flowCards/registerFlowCards';
import { createHomeModeCatalog } from '../../lib/home/homeModeCatalog';
import {
  MAIN_HOME_ID,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  PRICE_OPTIMIZATION_SETTINGS,
  TEMPERATURE_CONTROL_MODES,
  TEMPORARY_TEMPERATURE_TARGETS,
} from '../../lib/utils/settingsKeys';
import { readActiveTemporaryTemperatureC } from '../../lib/thermostat/temporaryTemperatureTargets';
import type { HomeMembershipPort } from '../../lib/home/membership';
import type { DeviceDescriptorRead } from '../../packages/contracts/src/types';
import type { SmartTaskInProgressRead } from '../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { partialDouble } from '../helpers/partialDouble';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { testLogger } from '../utils/testLogger';

const settings = mockHomeyInstance.settings;

const descriptor = (overrides: Partial<DeviceDescriptorRead>): DeviceDescriptorRead => partialDouble<DeviceDescriptorRead>({
  id: 'heater',
  name: 'Living room',
  deviceType: 'temperature',
  managed: true,
  isBatteryOrSolar: false,
  ...overrides,
});

const DEVICES = [
  descriptor({}),
  descriptor({ id: 'unmanaged', name: 'Garage', managed: false }),
  descriptor({ id: 'switch', name: 'Lamp', deviceType: 'onoff' }),
];

// A home without meter areas, or one with an area: every device lists under Main here.
// `pending` is the window after a meter area is saved, before membership recomputes.
const membership = (hasSubHomes: boolean, pending: boolean) => partialDouble<HomeMembershipPort>({
  isOwnershipReady: () => true,
  hasPendingOwnershipGeneration: () => pending,
  hasSubHomes: () => hasSubHomes,
  getHomeIdForDevice: () => MAIN_HOME_ID,
});

const register = (smartTask: SmartTaskInProgressRead = 'none', hasSubHomes = false, pending = false) => {
  const catalog = createHomeModeCatalog(
    MAIN_HOME_ID,
    settings,
    () => { throw new Error('Main reads its own catalog'); },
    () => ({ heater: true }),
    () => membership(hasSubHomes, pending),
    () => testLogger,
    () => ({ status: 'resolved', deviceIds: new Set() }),
  );
  const info = vi.fn();
  const normalizeTemperatureTarget = vi.fn((_deviceId: string, temperatureC: number) => Math.round(temperatureC * 2) / 2);
  registerTemperatureSettingsCards(partialDouble<FlowCardDeps>({
    homey: mockHomeyInstance as unknown as FlowCardDeps['homey'],
    getDeviceDescriptors: async () => DEVICES,
    listDeviceTargetModes: catalog.listDeviceTargetModes,
    setDeviceModeTarget: catalog.setDeviceModeTarget,
    normalizeTemperatureTarget,
    readSmartTaskInProgress: () => smartTask,
    getNow: () => new Date(NOW_MS),
    getStructuredLogger: () => partialDouble<ReturnType<FlowCardDeps['getStructuredLogger']> & object>({ info }),
  }));
  const run = (cardId: string, args: Record<string, unknown>) => mockHomeyInstance.flow._actionCardListeners[cardId](args);
  // The mock types its listeners with the query alone; Homey also hands over the card's other args.
  const autocomplete = (cardId: string, arg: string, query: string, args?: Record<string, unknown>) => {
    const listener = mockHomeyInstance.flow._actionCardAutocompleteListeners[cardId][arg] as (
      query: string, args?: Record<string, unknown>,
    ) => Promise<unknown>;
    return listener(query, args);
  };
  return { run, autocomplete, info, normalizeTemperatureTarget };
};

const HEATER = { id: 'heater', name: 'Living room' };
const NOW_MS = Date.UTC(2026, 10, 10, 12, 0);
const ACTIVE = { id: 'active-mode', name: 'Active mode', activeMode: true };

beforeEach(() => {
  resetMockHomey();
  settings.set(MODE_DEVICE_TARGETS, { Home: { heater: 21 }, Away: { heater: 16 } });
  settings.set(OPERATING_MODE_SETTING, 'Home');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('set_device_mode_temperature', () => {
  it('saves the snapped temperature in the active mode', async () => {
    const { run, info } = register();

    await expect(run('set_device_mode_temperature', { device: HEATER, mode: ACTIVE, temperature: 17.3 })).resolves.toBe(true);

    expect(settings.get(MODE_DEVICE_TARGETS)).toEqual({ Home: { heater: 17.5 }, Away: { heater: 16 } });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'flow_device_setting_saved', setting: 'mode_temperature', outcome: 'written', mode: 'Home', targetC: 17.5,
    }));
  });

  it('saves a named mode without touching the active one', async () => {
    const { run } = register();

    await run('set_device_mode_temperature', { device: HEATER, mode: { id: 'Away', name: 'Away' }, temperature: 14 });

    expect(settings.get(MODE_DEVICE_TARGETS)).toEqual({ Home: { heater: 21 }, Away: { heater: 14 } });
  });

  it('fails for a mode the device has no temperature in, and writes nothing', async () => {
    const { run } = register();

    await expect(run('set_device_mode_temperature', { device: HEATER, mode: { id: 'Cabin', name: 'Cabin' }, temperature: 14 }))
      .rejects.toThrow('There is no mode named "Cabin"');
    expect(settings.get(MODE_DEVICE_TARGETS)).toEqual({ Home: { heater: 21 }, Away: { heater: 16 } });
  });

  it('fails for a device that is not a managed temperature device', async () => {
    const { run } = register();

    await expect(run('set_device_mode_temperature', { device: { id: 'unmanaged' }, mode: ACTIVE, temperature: 14 }))
      .rejects.toThrow('not a temperature device managed by PELS');
    await expect(run('set_device_mode_temperature', { device: { id: 'gone' }, mode: ACTIVE, temperature: 14 }))
      .rejects.toThrow('does not know this device');
  });

  it('offers Active mode first, then the device\'s modes', async () => {
    const { autocomplete } = register();

    await expect(autocomplete('set_device_mode_temperature', 'mode', '', { device: HEATER })).resolves.toEqual([
      expect.objectContaining({ id: 'active-mode', activeMode: true }),
      { id: 'Away', name: 'Away' },
      { id: 'Home', name: 'Home' },
    ]);
    await expect(autocomplete('set_device_mode_temperature', 'mode', 'aw', { device: HEATER }))
      .resolves.toEqual([{ id: 'Away', name: 'Away' }]);
  });

  it('offers the home\'s modes before a device is picked when there are no meter areas', async () => {
    const { autocomplete } = register();

    await expect(autocomplete('set_device_mode_temperature', 'mode', '', {})).resolves.toEqual([
      expect.objectContaining({ id: 'active-mode', activeMode: true }),
      { id: 'Away', name: 'Away' },
      { id: 'Home', name: 'Home' },
    ]);
  });

  it('waits for membership to settle after a meter area is saved', async () => {
    const { autocomplete } = register('none', false, true);

    await expect(autocomplete('set_device_mode_temperature', 'mode', '', {})).resolves.toEqual([
      expect.objectContaining({ id: 'active-mode', activeMode: true }),
    ]);
  });

  it('waits for the device before offering modes when meter areas have their own', async () => {
    const { autocomplete } = register('none', true);

    await expect(autocomplete('set_device_mode_temperature', 'mode', '', {})).resolves.toEqual([
      expect.objectContaining({ id: 'active-mode', activeMode: true }),
    ]);
    await expect(autocomplete('set_device_mode_temperature', 'mode', '', { device: HEATER })).resolves.toEqual([
      expect.objectContaining({ id: 'active-mode', activeMode: true }),
      { id: 'Away', name: 'Away' },
      { id: 'Home', name: 'Home' },
    ]);
  });

  it('offers only managed temperature devices', async () => {
    const { autocomplete } = register();

    await expect(autocomplete('set_device_mode_temperature', 'device', '')).resolves.toEqual([HEATER]);
  });
});

describe('set_device_price_adjustment', () => {
  beforeEach(() => {
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater: { enabled: true, cheapDelta: 1, expensiveDelta: -1 } });
  });

  it('saves the chosen adjustment', async () => {
    const { run } = register();

    await run('set_device_price_adjustment', { device: HEATER, adjustment: 'expensive_hour_reduction', amount: 0 });
    await run('set_device_price_adjustment', { device: HEATER, adjustment: 'cheap_hour_boost', amount: 2.5 });

    expect(settings.get(PRICE_OPTIMIZATION_SETTINGS)).toEqual({ heater: { enabled: true, cheapDelta: 2.5, expensiveDelta: 0 } });
  });

  it('rejects an amount outside 0 to 20 °C', async () => {
    const { run } = register();

    await expect(run('set_device_price_adjustment', { device: HEATER, adjustment: 'cheap_hour_boost', amount: 25 }))
      .rejects.toThrow('between 0 and 20');
    await expect(run('set_device_price_adjustment', { device: HEATER, adjustment: 'cheap_hour_boost', amount: -1 }))
      .rejects.toThrow('between 0 and 20');
  });

  it('asks for Price-based control first while it is off for the device', async () => {
    const { run } = register();

    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater: { enabled: false, cheapDelta: 1, expensiveDelta: -1 } });
    await expect(run('set_device_price_adjustment', { device: HEATER, adjustment: 'cheap_hour_boost', amount: 2 }))
      .rejects.toThrow('Turn on Price-based control');

    settings.set(PRICE_OPTIMIZATION_SETTINGS, {});
    await expect(run('set_device_price_adjustment', { device: HEATER, adjustment: 'cheap_hour_boost', amount: 2 }))
      .rejects.toThrow('Turn on Price-based control');
  });
});

describe('set_device_temperature_control_mode', () => {
  it('saves the choice', async () => {
    const { run } = register();

    await run('set_device_temperature_control_mode', { device: HEATER, choice: 'external' });
    expect(settings.get(TEMPERATURE_CONTROL_MODES)).toEqual({ heater: 'external' });

    await run('set_device_temperature_control_mode', { device: HEATER, choice: 'mode' });
    expect(settings.get(TEMPERATURE_CONTROL_MODES)).toEqual({ heater: 'mode' });
  });

  it('allows only Return to mode target while a Smart task is in progress', async () => {
    const { run } = register('in_progress');

    await expect(run('set_device_temperature_control_mode', { device: HEATER, choice: 'external' }))
      .rejects.toThrow('active Smart task');
    expect(settings.get(TEMPERATURE_CONTROL_MODES)).toBeNull();
    await expect(run('set_device_temperature_control_mode', { device: HEATER, choice: 'mode' })).resolves.toBe(true);
  });

  it('refuses the other choices when it cannot tell whether a Smart task is in progress', async () => {
    const { run } = register('unavailable');

    await expect(run('set_device_temperature_control_mode', { device: HEATER, choice: 'update_mode' }))
      .rejects.toThrow('could not save the choice');
    expect(settings.get(TEMPERATURE_CONTROL_MODES)).toBeNull();
  });

  it('works for a temperature device PELS does not manage, as the settings UI row does', async () => {
    const { run, autocomplete } = register();

    await run('set_device_temperature_control_mode', { device: { id: 'unmanaged' }, choice: 'external' });
    expect(settings.get(TEMPERATURE_CONTROL_MODES)).toEqual({ unmanaged: 'external' });
    await expect(autocomplete('set_device_temperature_control_mode', 'device', ''))
      .resolves.toEqual([{ id: 'unmanaged', name: 'Garage' }, HEATER]);
  });
});

describe('set_device_temporary_temperature and end_device_temporary_temperature', () => {
  it('holds the snapped temperature until the duration is up', async () => {
    const { run, info } = register();

    await expect(run('set_device_temporary_temperature', { device: HEATER, temperature: 23.2, minutes: 90 }))
      .resolves.toBe(true);

    expect(settings.get(TEMPORARY_TEMPERATURE_TARGETS)).toEqual({ heater: { targetC: 23, untilMs: NOW_MS + 90 * 60_000 } });
    expect(readActiveTemporaryTemperatureC(settings, 'heater', NOW_MS + 89 * 60_000)).toBe(23);
    expect(readActiveTemporaryTemperatureC(settings, 'heater', NOW_MS + 90 * 60_000)).toBeNull();
    // The mode target is untouched: it is where the device returns.
    expect(settings.get(MODE_DEVICE_TARGETS)).toEqual({ Home: { heater: 21 }, Away: { heater: 16 } });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      setting: 'temporary_temperature', outcome: 'written', targetC: 23, minutes: 90,
    }));
  });

  it('ends it now, and says nothing changed when none is in force', async () => {
    const { run, info } = register();
    await run('set_device_temporary_temperature', { device: HEATER, temperature: 23, minutes: 30 });

    await run('end_device_temporary_temperature', { device: HEATER });
    expect(readActiveTemporaryTemperatureC(settings, 'heater', NOW_MS)).toBeNull();
    await run('end_device_temporary_temperature', { device: HEATER });
    expect(info).toHaveBeenLastCalledWith(expect.objectContaining({ setting: 'temporary_temperature_end', outcome: 'unchanged' }));
  });

  it('rejects a duration outside 1 to 1440 whole minutes', async () => {
    const { run } = register();
    for (const minutes of [0, 1441, 2.5, 'soon']) {
      await expect(run('set_device_temporary_temperature', { device: HEATER, temperature: 23, minutes }))
        .rejects.toThrow('Duration must be a whole number of minutes from 1 to 1440.');
    }
    expect(settings.get(TEMPORARY_TEMPERATURE_TARGETS)).toBeNull();
  });

  it('refuses a device set to Keep the new temperature', async () => {
    settings.set(TEMPERATURE_CONTROL_MODES, { heater: 'external' });
    const { run } = register();

    await expect(run('set_device_temporary_temperature', { device: HEATER, temperature: 23, minutes: 30 }))
      .rejects.toThrow('set to Keep the new temperature');
    expect(settings.get(TEMPORARY_TEMPERATURE_TARGETS)).toBeNull();
  });

  it('accepts a device set to Save as current mode target', async () => {
    settings.set(TEMPERATURE_CONTROL_MODES, { heater: 'update_mode' });
    const { run } = register();

    await run('set_device_temporary_temperature', { device: HEATER, temperature: 23, minutes: 30 });
    expect(readActiveTemporaryTemperatureC(settings, 'heater', NOW_MS)).toBe(23);
  });

  it('drops entries that have ended when it writes', async () => {
    settings.set(TEMPORARY_TEMPERATURE_TARGETS, {
      old: { targetC: 18, untilMs: NOW_MS - 1 },
      broken: { targetC: 'warm' },
    });
    const { run } = register();

    await run('set_device_temporary_temperature', { device: HEATER, temperature: 23, minutes: 30 });
    expect(Object.keys(settings.get(TEMPORARY_TEMPERATURE_TARGETS) as object)).toEqual(['heater']);
  });

  it('fails for a device that is not a managed temperature device', async () => {
    const { run, autocomplete } = register();

    await expect(run('set_device_temporary_temperature', { device: { id: 'unmanaged' }, temperature: 23, minutes: 30 }))
      .rejects.toThrow('not a temperature device managed by PELS');
    await expect(autocomplete('set_device_temporary_temperature', 'device', '')).resolves.toEqual([HEATER]);
  });
});
