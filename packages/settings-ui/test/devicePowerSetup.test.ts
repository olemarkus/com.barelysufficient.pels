import type { MdDialog } from '@material/web/dialog/dialog.js';
import type { MdFilledSelect } from '@material/web/select/filled-select.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevicePowerSetupEntry } from '../../contracts/src/settingsUi/devices.ts';
import { HOMEY_ENERGY_SETUP_REASON } from '../../shared-domain/src/homeyEnergySetup.ts';
import { DEVICE_BINARY_SWITCHES, DEVICE_POWER_SOURCES } from '../../shared-domain/src/settings/settingsKeys.ts';
import {
  acceptDevicePowerSetup, openGuidedDeviceSetup, readLastResortSetup,
  renderDeviceDetailPowerSetup, renderDevicePowerSetup,
} from '../src/ui/devicePowerSetup.ts';

const write = vi.hoisted(() => vi.fn());
vi.mock('../src/ui/deviceDetail/settingsWrite.ts', () => ({
  createSerializedAsyncRunner: () => ((operation: () => Promise<unknown>) => operation()),
  writeFreshSetting: write,
}));

const device = (overrides: Partial<DevicePowerSetupEntry> = {}): DevicePowerSetupEntry => ({
  id: 'spa',
  name: 'Tuins Spa',
  homeId: 'main',
  configured: false,
  sourceId: null,
  sourceReady: false,
  defaultBinarySwitchAvailable: true,
  binarySwitches: [{ id: 'onoff.heater', name: 'Heater' }],
  lastResortAvailable: true,
  sources: [{ id: 'socket', name: 'Spa-stroommeter', state: 'selectable', measuredPowerW: 1700 }],
  usedBy: null,
  ...overrides,
});

const accept = (overrides?: Partial<DevicePowerSetupEntry>) => {
  acceptDevicePowerSetup({ devices: [device(overrides)] });
};

const prefix = 'device-power-setup';
const query = <T extends HTMLElement>(suffix: string, id = prefix): T => {
  const element = document.querySelector<T>(`#${id}-${suffix}`);
  if (!element) throw new Error(`Missing device setup control ${id}-${suffix}`);
  return element;
};

const select = (suffix: string, value: string) => {
  const control = query<MdFilledSelect>(suffix);
  control.value = value;
  control.dispatchEvent(new Event('change'));
  return control;
};

const setup = () => {
  document.body.innerHTML = `
    <md-dialog id="device-power-setup">
      <h3 slot="headline"></h3>
      <div data-setup-host></div><p data-setup-review></p><p data-setup-simulation></p><p data-setup-status></p>
      <button data-setup-dismiss></button><button data-setup="save"></button>
    </md-dialog>
    <section id="device-detail-power-setup" hidden><div data-setup-host></div></section>
    <div id="device-detail-binary-switch" hidden></div>
    <div id="device-detail-last-resort" hidden></div>`;
  const dialog = document.getElementById(prefix) as MdDialog;
  vi.spyOn(dialog, 'show').mockImplementation(async () => { dialog.open = true; });
  vi.spyOn(dialog, 'close').mockImplementation(async () => { dialog.open = false; });
  const refresh = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const manage = vi.fn<(id: string, enabled: boolean) => Promise<boolean>>().mockResolvedValue(true);
  const managedDisabledReason = vi.fn<() => string | null>().mockReturnValue(null);
  const offersHomeyEnergy = vi.fn().mockReturnValue(false);
  const actions = { refresh, manage, managedDisabledReason, offersHomeyEnergy, simulation: () => true };
  renderDevicePowerSetup(actions);
  openGuidedDeviceSetup('spa');
  const save = query<HTMLButtonElement>('save');
  return { dialog, refresh, manage, actions, save };
};

const configured = { configured: true, binarySwitchId: 'onoff.heater', sourceId: 'socket' } as const;
const review = (save: HTMLButtonElement) => {
  select('source', 'socket');
  select('binary', 'onoff.heater');
  expect(save.disabled).toBe(false);
  save.click();
};

describe('Guided device setup', () => {
  beforeEach(() => {
    write.mockReset().mockResolvedValue({});
    accept();
  });

  it('requires an explicit switch choice and activates only after reading back the wiring', async () => {
    const { dialog, refresh, manage, save } = setup();
    expect(dialog.querySelector('[slot="headline"]')?.textContent).toBe('Set up Tuins Spa');
    expect(save.disabled).toBe(true);
    select('source', 'socket');
    expect(query('help').textContent).toContain(`${(1700).toLocaleString()} W`);
    expect(save.disabled).toBe(true);
    select('binary', 'onoff.heater');
    expect(write).not.toHaveBeenCalled();
    save.click();
    expect(dialog.querySelector('[data-setup-review]')?.textContent).toContain('PELS can turn off Heater.');
    expect(dialog.querySelector('[data-setup-review]')?.textContent)
      .toContain(`Latest reading: ${(1700).toLocaleString()} W.`);
    expect(save.textContent).toBe('Add to PELS');
    refresh.mockImplementation(async () => {
      expect(manage).not.toHaveBeenCalled();
      accept({ ...configured, sourceReady: true });
      return true;
    });
    save.click();
    await vi.waitFor(() => expect(dialog.open).toBe(false));
    expect(manage).toHaveBeenCalledExactlyOnceWith('spa', true);
    expect(write.mock.calls.map(([request]) => request.key)).toEqual([DEVICE_BINARY_SWITCHES, DEVICE_POWER_SOURCES]);
  });

  it('keeps wiring and retries without activating while a meter has no reading', async () => {
    const { actions, dialog, refresh, manage, save } = setup();
    review(save);
    refresh.mockImplementation(async () => {
      accept(configured);
      return true;
    });
    save.click();
    await vi.waitFor(() => expect(dialog.textContent).toContain('Wait for its first power reading'));
    expect(manage).not.toHaveBeenCalled();
    expect(save.textContent).toBe('Check meter');
    accept({ ...configured, sources: [] });
    renderDevicePowerSetup(actions);
    expect(save.disabled).toBe(false);
    refresh.mockImplementation(async () => {
      accept({ ...configured, sourceReady: true });
      return true;
    });
    save.click();
    await vi.waitFor(() => expect(dialog.open).toBe(false));
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('shows why management was refused and retries without rewriting confirmed wiring', async () => {
    const { actions, dialog, refresh, manage, save } = setup();
    review(save);
    refresh.mockImplementation(async () => {
      accept({ ...configured, sourceReady: true });
      return true;
    });
    manage.mockResolvedValueOnce(false);
    actions.managedDisabledReason.mockReturnValue('Managed requires built-in device control to be enabled in Homey.');
    save.click();
    await vi.waitFor(() => expect(dialog.querySelector('[data-setup-status]')?.textContent)
      .toBe('Managed requires built-in device control to be enabled in Homey.'));
    expect(save.textContent).toBe('Add to PELS');
    expect(write).toHaveBeenCalledTimes(2);
    save.click();
    await vi.waitFor(() => expect(dialog.open).toBe(false));
    expect(manage).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('checks the reviewed meter after an outside change and keeps the original choice for a deliberate retry', async () => {
    const { actions, dialog, refresh, manage, save } = setup();
    review(save);
    refresh.mockImplementation(async () => {
      accept(configured);
      return true;
    });
    save.click();
    await vi.waitFor(() => expect(save.textContent).toBe('Check meter'));
    accept({ ...configured, sourceId: null });
    renderDevicePowerSetup(actions);
    refresh.mockImplementation(async () => {
      accept({ ...configured, sourceId: null });
      return true;
    });
    save.click();
    await vi.waitFor(() => expect(dialog.textContent).toContain('Could not confirm the power source.'));
    expect(query<MdFilledSelect>('source').value).toBe('socket');
    expect(manage).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('saves a newly released socket after going back from a confirmed meter', async () => {
    const other = { id: 'second', name: 'Other meter', state: 'managed' as const };
    const sources = [...device().sources, other];
    accept({ sources });
    const { dialog, refresh, manage, save } = setup();
    review(save);
    refresh.mockImplementation(async () => {
      accept({ ...configured, sources });
      return true;
    });
    save.click();
    await vi.waitFor(() => expect(save.textContent).toBe('Check meter'));
    dialog.querySelector<HTMLButtonElement>('[data-setup-dismiss]')?.click();
    const releasedSources = [...device().sources, { ...other, state: 'selectable' as const }];
    refresh.mockImplementationOnce(async () => {
      accept({ ...configured, sources: releasedSources });
      return true;
    });
    query('managed-sockets').querySelector<HTMLElement>('md-text-button')?.click();
    await vi.waitFor(() => expect(query<MdFilledSelect>('source').value).toBe('second'));
    save.click();
    refresh.mockImplementation(async () => {
      accept({ ...configured, sourceId: 'second', sourceReady: true, sources: releasedSources });
      return true;
    });
    save.click();
    await vi.waitFor(() => expect(dialog.open).toBe(false));
    expect(write.mock.calls.map(([request]) => request.key)).toEqual([
      DEVICE_BINARY_SWITCHES, DEVICE_POWER_SOURCES, DEVICE_POWER_SOURCES,
    ]);
    expect(manage.mock.calls).toEqual([['second', false], ['spa', true]]);
  });

  it('offers Homey Energy as another source of power information for a supported relay', () => {
    const { actions } = setup();
    actions.offersHomeyEnergy.mockReturnValue(true);
    renderDevicePowerSetup(actions);
    expect(query('help').textContent).toContain('Choose a metering socket');
    expect(query('help').textContent).toContain(HOMEY_ENERGY_SETUP_REASON);
    select('source', 'socket');
    expect(query('help').textContent).not.toContain('Energy used when on');
  });

  it('shows zero watts from a device with its own meter when reviewing setup', () => {
    accept({ ownPowerW: 0, binarySwitches: [] });
    const { dialog, save } = setup();
    save.click();
    expect(dialog.querySelector('[data-setup-review]')?.textContent).toContain('Latest reading: 0 W.');
  });

  it('retains the draft for retry after a partial save or skipped refresh', async () => {
    const { actions, dialog, refresh, manage, save } = setup();
    review(save);
    const control = query<MdFilledSelect>('binary');
    write.mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    refresh.mockImplementationOnce(async () => {
      accept({ binarySwitchId: 'onoff.heater' });
      renderDevicePowerSetup(actions);
      return true;
    }).mockResolvedValueOnce(false);
    save.click();
    await vi.waitFor(() => expect(dialog.textContent).toContain('Try again'));
    expect(save.disabled).toBe(false);
    expect(control.value).toBe('onoff.heater');
    expect(query<MdFilledSelect>('source').value).toBe('socket');
    save.click();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(manage).not.toHaveBeenCalled();
  });

  it('offers a managed socket as a meter only after the user releases it and the app confirms', async () => {
    accept({ sources: [{ id: 'socket', name: 'Spa-stroommeter', state: 'managed' }] });
    const { refresh, manage } = setup();
    const picker = query<MdFilledSelect>('source');
    expect(picker.querySelector('[value="socket"]')).toHaveProperty('disabled', true);
    refresh.mockImplementation(async () => { accept(); return true; });
    query('managed-sockets').querySelector<HTMLElement>('md-text-button')?.click();
    await vi.waitFor(() => expect(picker.value).toBe('socket'));
    expect(manage).toHaveBeenCalledExactlyOnceWith('socket', false);
    expect(write).not.toHaveBeenCalled();
  });

  it('offers a maximum for last-resort control only if a usable switch is chosen', () => {
    accept({ defaultBinarySwitchAvailable: false });
    const { save } = setup();
    const toggle = query<HTMLElement & { selected: boolean; disabled: boolean }>('last-resort-toggle');
    expect(toggle.disabled).toBe(true);
    select('binary', 'onoff.heater');
    expect(toggle.disabled).toBe(false);
    toggle.selected = true;
    toggle.dispatchEvent(new Event('change'));
    expect(save.disabled).toBe(true);
    const maximum = query<HTMLInputElement>('maximum');
    maximum.value = '6000';
    maximum.dispatchEvent(new Event('input'));
    expect(save.disabled).toBe(false);
  });
});

describe('Device detail setup', () => {
  beforeEach(() => accept());

  it('shows each part in its own section and hides parts for a reserved socket', () => {
    setup();
    const parts = ['device-detail-power-setup', 'device-detail-binary-switch', 'device-detail-last-resort'];
    renderDeviceDetailPowerSetup('spa');
    expect(parts.map((id) => document.getElementById(id)?.hidden)).toEqual([false, false, false]);
    accept({ ...configured, sourceReady: true, binarySwitchId: null, binarySwitches: [] });
    renderDeviceDetailPowerSetup('spa');
    expect(parts.map((id) => document.getElementById(id)?.hidden)).toEqual([false, true, true]);
    accept({ usedBy: 'heater' });
    renderDeviceDetailPowerSetup('spa');
    expect(parts.map((id) => document.getElementById(id)?.hidden)).toEqual([true, true, true]);
  });

  it('keeps the external meter ahead of a stale last-resort maximum', () => {
    accept({ ...configured, lastResortMaximumW: 4500 });
    expect(readLastResortSetup('spa')).toBeUndefined();
  });
});
