import type { MdFilledSelect } from '@material/web/select/filled-select.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevicePowerSetupEntry } from '../../contracts/src/settingsUi/devices.ts';
import {
  DEVICE_BINARY_SWITCHES, DEVICE_EXTERNAL_THERMOSTATS, DEVICE_POWER_SOURCES, LAST_RESORT_DEVICES,
} from '../../shared-domain/src/settings/settingsKeys.ts';
import {
  acceptDevicePowerSetup, isDeviceReservedBySetup, readLastResortSetup, renderDeviceDetailPowerSetup,
  renderDevicePowerSetup,
} from '../src/ui/devicePowerSetup.ts';

const write = vi.hoisted(() => vi.fn());
vi.mock('../src/ui/deviceDetail/settingsWrite.ts', () => ({
  createSerializedAsyncRunner: () => ((operation: () => Promise<unknown>) => operation()),
  writeFreshSetting: write,
}));

const device = (overrides: Partial<DevicePowerSetupEntry> = {}): DevicePowerSetupEntry => ({
  id: 'heater',
  name: 'Heater',
  configured: true,
  sourceId: 'socket',
  sourceReady: true,
  binarySwitchId: 'onoff.heater',
  defaultBinarySwitchAvailable: true,
  binarySwitches: [{ id: 'onoff.heater', name: 'Heater switch' }],
  lastResortAvailable: true,
  sources: [{ id: 'socket', name: 'Metering socket', state: 'selectable' }],
  usedBy: null,
  ...overrides,
});

// The device page's form; its controls carry this id prefix.
const PREFIX = 'device-detail-power-setup';
// A Material select cannot show an option with an empty value, so defaults use this one.
const DEFAULT = 'pels-default';

const query = <T extends HTMLElement>(suffix: string): T => {
  const element = document.querySelector<T>(`#${PREFIX}-${suffix}`);
  if (!element) throw new Error(`Missing device setup control ${suffix}`);
  return element;
};

const rerender = (refresh: () => Promise<void>, listed: readonly string[] = ['heater']) => (
  renderDevicePowerSetup(refresh, true, new Set(listed))
);

const setup = () => {
  document.body.innerHTML = `
    <details id="device-power-setup" hidden><div data-setup-host></div></details>
    <div id="${PREFIX}" hidden><div data-setup-host></div></div>`;
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  rerender(refresh);
  renderDeviceDetailPowerSetup('heater');
  const control = query<MdFilledSelect>('binary');
  // jsdom has no Element.animate; a quick select opens its menu without animating.
  control.quick = true;
  const source = query<MdFilledSelect>('source');
  const thermostat = query<MdFilledSelect>('thermostat');
  const confirmation = Object.assign(query('thermostat-confirm'), { returnValue: '', show: vi.fn() });
  const toggle = query<HTMLElement & { selected: boolean; disabled: boolean }>('last-resort-toggle');
  const maximum = query<HTMLInputElement>('maximum');
  const save = query<HTMLButtonElement>('save');
  return { control, source, thermostat, confirmation, toggle, maximum, save, refresh };
};

const change = (control: HTMLElement, type = 'change') => control.dispatchEvent(new Event(type));

describe('Device setup', () => {
  beforeEach(() => {
    write.mockReset();
    acceptDevicePowerSetup({ devices: [device()] });
  });

  it('keeps cleared selections and maximum through equivalent refresh and a partial save', async () => {
    const { control, source, toggle, maximum, save, refresh } = setup();
    const selectedOption = control.lastElementChild;
    control.showPicker();
    await control.updateComplete;
    const menu = control.shadowRoot?.querySelector('md-menu');
    expect(menu).toHaveProperty('open', true);
    expect(control.value).toBe('onoff.heater');
    expect(source.value).toBe('socket');
    source.value = DEFAULT;
    change(source);
    control.value = DEFAULT;
    change(control);
    toggle.selected = true;
    change(toggle);
    maximum.value = '6000';
    change(maximum, 'input');

    acceptDevicePowerSetup({ devices: [device()] });
    rerender(refresh);
    await control.updateComplete;
    expect(control.lastElementChild).toBe(selectedOption);
    expect(control.shadowRoot?.querySelector('md-menu')).toBe(menu);
    expect(menu).toHaveProperty('open', true);
    expect(selectedOption?.isConnected).toBe(true);
    expect(control.value).toBe(DEFAULT);
    expect(source.value).toBe(DEFAULT);
    expect(maximum.value).toBe('6000');

    write.mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    refresh.mockImplementation(async () => {
      acceptDevicePowerSetup({ devices: [device({ binarySwitchId: null })] });
      rerender(refresh);
    });
    save.click();
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(write.mock.calls.map(([request]) => request.key)).toEqual([DEVICE_BINARY_SWITCHES, DEVICE_POWER_SOURCES]);
    expect(control.value).toBe(DEFAULT);
    expect(source.value).toBe(DEFAULT);
    expect(toggle.selected).toBe(true);
    expect(maximum.value).toBe('6000');
  });

  it('keeps acknowledged selections until a refresh includes their readback', async () => {
    const { control, source, save, refresh } = setup();
    source.value = DEFAULT;
    change(source);
    control.value = DEFAULT;
    change(control);
    write.mockResolvedValue({});

    save.click();
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(refresh).toHaveBeenCalledOnce();
    expect(control.value).toBe(DEFAULT);
    expect(source.value).toBe(DEFAULT);

    acceptDevicePowerSetup({ devices: [device({ binarySwitchId: null, sourceId: null })] });
    rerender(refresh);
    acceptDevicePowerSetup({ devices: [device()] });
    rerender(refresh);
    expect(control.value).toBe('onoff.heater');
    expect(source.value).toBe('socket');
  });

  it('names the own reading of the device, or None, and keeps Save off until something changes', () => {
    acceptDevicePowerSetup({ devices: [device({ sourceId: null, binarySwitchId: null, ownPowerW: 850 })] });
    const { source, control, save, refresh } = setup();
    expect(source.value).toBe(DEFAULT);
    expect(source.querySelector(`[value="${DEFAULT}"]`)?.textContent).toContain('This device');
    expect(query('help').textContent).toBe(`Uses this device's own reading, now ${(850).toLocaleString()} W.`);
    acceptDevicePowerSetup({ devices: [device({ sourceId: null, binarySwitchId: null })] });
    rerender(refresh);
    expect(source.querySelector(`[value="${DEFAULT}"]`)?.textContent).toContain('None');
    expect(query('help').textContent).toBe('This device has no power reading. Choose a metering socket to measure it.');
    expect(control.value).toBe(DEFAULT);
    expect(save.disabled).toBe(true);
    source.value = 'socket';
    change(source);
    expect(query('help').textContent).toBe("PELS reads this device's power from Metering socket.");
    expect(save.disabled).toBe(false);
  });

  it('offers only devices outside the device list for adding and hides the card without any', () => {
    acceptDevicePowerSetup({ devices: [device(), device({ id: 'spa', name: 'Spa', configured: false, sourceId: null })] });
    const { refresh } = setup();
    const card = document.querySelector<HTMLElement>('#device-power-setup');
    const target = document.querySelector<MdFilledSelect>('#device-power-setup-target');
    expect(card?.hidden).toBe(false);
    expect([...target?.querySelectorAll('[value]') ?? []].map((option) => option.textContent?.trim()))
      .toEqual(['Select a device', 'Spa']);
    expect(document.querySelector<HTMLElement>('#device-power-setup-details')?.hidden).toBe(true);
    expect(rerender(refresh, ['heater', 'spa'])).toBe(false);
    expect(card?.hidden).toBe(true);
  });

  it('offers no new thermostat link but keeps a saved one visible for removal', () => {
    const thermostats = [{ id: 'thermostat', name: 'Room thermostat', state: 'selectable' as const }];
    acceptDevicePowerSetup({ devices: [device({ thermostats })] });
    const { refresh } = setup();
    expect(query('thermostat-field').hidden).toBe(true);
    acceptDevicePowerSetup({ devices: [device({ thermostats, thermostatId: 'thermostat', thermostatReady: true })] });
    rerender(refresh);
    expect(query('thermostat-field').hidden).toBe(false);
  });

  it('hides the device page form for a socket that measures another device', () => {
    acceptDevicePowerSetup({ devices: [device(), device({ id: 'socket', name: 'Socket', usedBy: 'heater' })] });
    setup();
    renderDeviceDetailPowerSetup('socket');
    expect(document.getElementById(PREFIX)?.hidden).toBe(true);
    renderDeviceDetailPowerSetup('heater');
    expect(document.getElementById(PREFIX)?.hidden).toBe(false);
  });

  it('gives the selected metering socket precedence over a stale last-resort maximum', () => {
    acceptDevicePowerSetup({ devices: [device({ lastResortMaximumW: 4500 })] });
    expect(readLastResortSetup('heater')).toBeUndefined();
  });

  it('previews without writing, confirms a last-resort link, and retries the remaining write', async () => {
    const before = device({
      sourceId: null,
      lastResortMaximumW: 4500,
      thermostats: [
        { id: 'thermostat', name: 'Room thermostat', state: 'selectable', currentTemperature: 20, targetTemperature: 22 },
        { id: 'managed', name: 'Managed thermostat', state: 'managed' },
      ],
    });
    acceptDevicePowerSetup({ devices: [before] });
    const { thermostat, confirmation, save, refresh } = setup();
    expect(thermostat.textContent).toContain('Turn off Managed by PELS to use this thermostat');
    thermostat.value = 'thermostat';
    change(thermostat);
    expect(query('thermostat-preview').textContent).toBe('Temperature 20 °C · Target 22 °C');
    expect(write).not.toHaveBeenCalled();

    save.click();
    expect(confirmation.show).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    confirmation.dispatchEvent(new Event('close'));
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(write).not.toHaveBeenCalled();

    const linked = { ...before, thermostatId: 'thermostat', thermostatWaitingForManualOn: true };
    write.mockImplementation(({ key, mutate }) => Promise.resolve(
      key === DEVICE_EXTERNAL_THERMOSTATS ? mutate({}) : null,
    ));
    refresh.mockImplementation(async () => {
      acceptDevicePowerSetup({ devices: [linked] });
      rerender(refresh);
    });
    save.click();
    confirmation.returnValue = 'confirm';
    confirmation.dispatchEvent(new Event('close'));
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(write.mock.calls.map(([request]) => request.key)).toEqual([DEVICE_EXTERNAL_THERMOSTATS, LAST_RESORT_DEVICES]);
    expect(await write.mock.results[0]?.value).toEqual({
      heater: { thermostatId: 'thermostat', waitForManualOn: true },
    });
    expect(thermostat.value).toBe('thermostat');

    write.mockReset().mockResolvedValue({});
    save.click();
    confirmation.returnValue = 'confirm';
    confirmation.dispatchEvent(new Event('close'));
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(write.mock.calls.map(([request]) => request.key)).toEqual([LAST_RESORT_DEVICES]);
  });

  it('allows removing an unavailable saved thermostat and preserves its manual restart hold', async () => {
    acceptDevicePowerSetup({ devices: [
      device({
        sourceId: null, thermostatId: 'thermostat', thermostatWaitingForManualOn: true,
        lastResortMaximumW: 4500, thermostats: [],
      }),
      device({ id: 'thermostat', name: 'Thermostat', thermostatUsedBy: 'heater' }),
    ] });
    const { thermostat, confirmation, save } = setup();
    expect(isDeviceReservedBySetup('thermostat')).toBe(true);
    expect(thermostat.textContent).toContain('Configured thermostat unavailable');
    thermostat.value = DEFAULT;
    change(thermostat);
    write.mockImplementation(({ mutate, fallbackValue }) => Promise.resolve(mutate(fallbackValue)));
    save.click();
    confirmation.returnValue = 'confirm';
    confirmation.dispatchEvent(new Event('close'));
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(write.mock.calls.map(([request]) => request.key)).toEqual([LAST_RESORT_DEVICES, DEVICE_EXTERNAL_THERMOSTATS]);
    expect(await write.mock.results[1]?.value).toEqual({ heater: { thermostatId: null, waitForManualOn: true } });
  });

  it('requires an available selected switch and offers removal if a saved switch goes away', () => {
    acceptDevicePowerSetup({ devices: [device({
      sourceId: null,
      binarySwitchId: null,
      defaultBinarySwitchAvailable: false,
    })] });
    const { control, toggle, save, refresh } = setup();
    expect(toggle.disabled).toBe(true);
    expect(control.textContent).toContain('No on/off control');
    expect(query('last-resort-help').textContent).toContain('Choose an available on/off control');

    control.value = 'onoff.heater';
    change(control);
    expect(toggle.disabled).toBe(false);

    // Leave the device page to discard the edit before reading accepted settings again.
    renderDeviceDetailPowerSetup(undefined);
    acceptDevicePowerSetup({ devices: [device({
      sourceId: null,
      defaultBinarySwitchAvailable: false,
      binarySwitches: [],
      lastResortAvailable: false,
      lastResortMaximumW: 6000,
    })] });
    renderDeviceDetailPowerSetup('heater');
    rerender(refresh);
    expect(toggle.selected).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(save.disabled).toBe(true);
    toggle.selected = false;
    change(toggle);
    expect(save.disabled).toBe(false);
  });
});
