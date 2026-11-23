import type { MdFilledSelect } from '@material/web/select/filled-select.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevicePowerSetupEntry } from '../../contracts/src/settingsUi/devices.ts';
import {
  DEVICE_BINARY_SWITCHES, DEVICE_EXTERNAL_THERMOSTATS, DEVICE_POWER_SOURCES, LAST_RESORT_DEVICES,
} from '../../shared-domain/src/settings/settingsKeys.ts';
import {
  acceptDevicePowerSetup, isDeviceReservedBySetup, openDevicePowerSetup, readLastResortSetup, renderDevicePowerSetup,
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

const query = <T extends HTMLElement>(suffix: string): T => {
  const element = document.querySelector<T>(`#device-power-setup-${suffix}`);
  if (!element) throw new Error(`Missing device setup control ${suffix}`);
  return element;
};

const setup = () => {
  document.body.innerHTML = `
    <details id="device-power-setup" hidden>
      <summary>Device setup</summary>
      <md-filled-select id="device-power-setup-target"></md-filled-select>
      <md-filled-select id="device-power-setup-source"></md-filled-select>
      <div id="device-power-setup-help"></div>
      <div id="device-power-setup-binary-field"></div>
      <md-filled-select id="device-power-setup-binary" quick></md-filled-select>
      <div id="device-power-setup-binary-help"></div>
      <div id="device-power-setup-thermostat-field"></div>
      <md-filled-select id="device-power-setup-thermostat"></md-filled-select>
      <div id="device-power-setup-thermostat-preview"></div>
      <div id="device-power-setup-thermostat-status"></div>
      <div id="device-power-setup-thermostat-confirm"></div>
      <div id="device-power-setup-last-resort"></div>
      <div id="device-power-setup-last-resort-help"></div>
      <div id="device-power-setup-last-resort-toggle"></div>
      <input id="device-power-setup-maximum">
      <button id="device-power-setup-save"></button>
    </details>`;
  const control = query<MdFilledSelect>('binary');
  const source = query<MdFilledSelect>('source');
  const thermostat = query<MdFilledSelect>('thermostat');
  const confirmation = Object.assign(query('thermostat-confirm'), { returnValue: '', show: vi.fn() });
  const toggle = Object.assign(query('last-resort-toggle'), { selected: false, disabled: false });
  const maximum = query<HTMLInputElement>('maximum');
  const save = query<HTMLButtonElement>('save');
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  renderDevicePowerSetup(refresh, true);
  openDevicePowerSetup('heater');
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
    source.value = '';
    change(source);
    control.value = '';
    change(control);
    toggle.selected = true;
    change(toggle);
    maximum.value = '6000';
    change(maximum, 'input');

    acceptDevicePowerSetup({ devices: [device()] });
    renderDevicePowerSetup(refresh, true);
    await control.updateComplete;
    expect(control.lastElementChild).toBe(selectedOption);
    expect(control.shadowRoot?.querySelector('md-menu')).toBe(menu);
    expect(menu).toHaveProperty('open', true);
    expect(selectedOption?.isConnected).toBe(true);
    expect(control.value).toBe('');
    expect(source.value).toBe('');
    expect(maximum.value).toBe('6000');

    write.mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    refresh.mockImplementation(async () => {
      acceptDevicePowerSetup({ devices: [device({ binarySwitchId: null })] });
      renderDevicePowerSetup(refresh, true);
    });
    save.click();
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(write.mock.calls.map(([request]) => request.key)).toEqual([DEVICE_BINARY_SWITCHES, DEVICE_POWER_SOURCES]);
    expect(control.value).toBe('');
    expect(source.value).toBe('');
    expect(toggle.selected).toBe(true);
    expect(maximum.value).toBe('6000');
  });

  it('keeps acknowledged selections until a refresh includes their readback', async () => {
    const { control, source, save, refresh } = setup();
    source.value = '';
    change(source);
    control.value = '';
    change(control);
    write.mockResolvedValue({});

    save.click();
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(refresh).toHaveBeenCalledOnce();
    expect(control.value).toBe('');
    expect(source.value).toBe('');

    acceptDevicePowerSetup({ devices: [device({ binarySwitchId: null, sourceId: null })] });
    renderDevicePowerSetup(refresh, true);
    acceptDevicePowerSetup({ devices: [device()] });
    renderDevicePowerSetup(refresh, true);
    expect(control.value).toBe('onoff.heater');
    expect(source.value).toBe('socket');
  });

  it('remembers a requested device when the setup form is initially hidden', () => {
    const { control, refresh } = setup();
    const root = document.querySelector<HTMLDetailsElement>('#device-power-setup');
    if (!root) throw new Error('Missing setup form');
    openDevicePowerSetup('');
    root.open = false;
    renderDevicePowerSetup(refresh, false);

    openDevicePowerSetup('heater');
    expect(root.open).toBe(false);
    renderDevicePowerSetup(refresh, true);
    expect(root.open).toBe(true);
    expect(control.value).toBe('onoff.heater');
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
      renderDevicePowerSetup(refresh, true);
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
    thermostat.value = '';
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

    // Select another target to discard the edit before reading accepted settings again.
    openDevicePowerSetup('');
    acceptDevicePowerSetup({ devices: [device({
      sourceId: null,
      defaultBinarySwitchAvailable: false,
      binarySwitches: [],
      lastResortAvailable: false,
      lastResortMaximumW: 6000,
    })] });
    openDevicePowerSetup('heater');
    renderDevicePowerSetup(refresh, true);
    expect(toggle.selected).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(save.disabled).toBe(true);
    toggle.selected = false;
    change(toggle);
    expect(save.disabled).toBe(false);
  });
});
