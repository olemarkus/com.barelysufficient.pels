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
} from '../../lib/utils/settingsKeys';
import type { DeviceDescriptorRead } from '../../packages/contracts/src/types';
import type { SmartTaskInProgressRead } from '../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { partialDouble } from '../helpers/partialDouble';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';

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

const register = (smartTask: SmartTaskInProgressRead = 'none') => {
  const catalog = createHomeModeCatalog(
    MAIN_HOME_ID,
    settings,
    () => { throw new Error('Main reads its own catalog'); },
    () => ({ heater: true }),
    () => undefined,
    () => undefined,
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
