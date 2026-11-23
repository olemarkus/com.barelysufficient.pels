import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices';
import { mockDeviceListCollaborators } from './helpers/deviceListCollaborators.ts';

const setupDom = () => {
  const root = document.body;
  root.replaceChildren();
  const deviceListEl = document.createElement('div');
  deviceListEl.id = 'device-list';
  const cardListEl = document.createElement('div');
  cardListEl.id = 'device-card-list';
  const emptyStateEl = document.createElement('p');
  emptyStateEl.id = 'empty-state';
  const refreshBtn = document.createElement('button');
  refreshBtn.id = 'refresh-button';
  root.append(deviceListEl, cardListEl, emptyStateEl, refreshBtn);
};

const buildDevice = (overrides: Partial<SettingsUiDeviceSnapshot> = {}): SettingsUiDeviceSnapshot => (withDescriptorIdentity<SettingsUiDeviceSnapshot>({ available: true, expectedPowerKw: 1, expectedPowerSource: 'default',
  id: 'device-1',
  name: 'Test Device',
  targets: [],
  deviceType: 'temperature',
  binaryControl: { on: true },
  ...overrides,
}));

describe('devices render', () => {
  beforeEach(() => {
    vi.resetModules();
    setupDom();
  });

  it('renders unavailable devices with a gray badge', async () => {
    mockDeviceListCollaborators();

    const { renderDevices } = await import('../src/ui/devices.ts');
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.latestDevices = [buildDevice({ available: false })];
    state.budgetExemptMap = {};

    renderDevices(state.latestDevices);

    const row = document.querySelector('[data-device-id="device-1"]') as HTMLElement | null;
    expect(row?.textContent).toContain('Unavailable');
    expect(row?.querySelector('.device-row__state-chip')?.textContent).toBe('Unavailable');
    expect(row?.querySelector('.device-row__state-chip')?.getAttribute('data-tooltip')).toBe('Device is currently unavailable in Homey.');
    expect(row?.querySelector('.device-row__state-chip')?.getAttribute('title')).toBeNull();
  });

  it('renders budget-exempt devices with a gray badge', async () => {
    mockDeviceListCollaborators();

    const { renderDevices } = await import('../src/ui/devices.ts');
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.latestDevices = [buildDevice()];
    state.budgetExemptMap = { 'device-1': true };

    renderDevices(state.latestDevices);

    const row = document.querySelector('[data-device-id="device-1"]') as HTMLElement | null;
    expect(row?.textContent).toContain('Budget exempt');
    expect(row?.querySelector('.device-row__state-chip')?.textContent).toBe('Budget exempt');
    expect(row?.querySelector('.device-row__state-chip')?.getAttribute('data-tooltip')).toBe('This device is excluded from daily budget limits.');
    expect(row?.querySelector('.device-row__state-chip')?.getAttribute('title')).toBeNull();
  });
});

describe('devices render — redesign shell', () => {
  beforeEach(() => {
    vi.resetModules();
    setupDom();
    mockDeviceListCollaborators();
  });

  const importDevicesInRedesign = async () => {
    return import('../src/ui/devices.ts');
  };

  it('uses the last-resort description instead of the Homey Energy warning for a configured relay', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');
    const { acceptDevicePowerSetup } = await import('../src/ui/devicePowerSetup.ts');
    state.initialLoadComplete = true;
    acceptDevicePowerSetup({ devices: [{
      id: 'relay', name: 'Relay', configured: true, sourceId: null, sourceReady: false, usedBy: null, sources: [],
      lastResortMaximumW: 4500, lastResortAvailable: true, defaultBinarySwitchAvailable: true,
    }] });
    const switchDevice = { deviceType: 'onoff' as const, deviceClass: 'socket', powerCapable: false,
      binaryControllable: true, capabilities: ['onoff'] };
    renderDevices([
      buildDevice({ ...switchDevice, id: 'relay', name: 'Relay' }),
      buildDevice({ ...switchDevice, id: 'ordinary', name: 'Ordinary' }),
    ]);

    const relay = () => document.querySelector('[data-device-id="relay"]');
    expect(relay()?.textContent).toContain('Turn on Managed by PELS to use last-resort control.');
    expect(relay()?.querySelector('.pels-device-card__power-warning')).toBeNull();
    expect(document.querySelector('[data-device-id="ordinary"] .pels-device-card__power-warning')).not.toBeNull();

    state.managedMap = { relay: true };
    renderDevices([buildDevice({ ...switchDevice, id: 'relay', name: 'Relay' })]);
    expect(relay()?.textContent).toContain('Last resort.');
  });

  it('points an unmetered relay to last-resort control and names a missing socket or thermostat', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');
    const { acceptDevicePowerSetup } = await import('../src/ui/devicePowerSetup.ts');
    state.initialLoadComplete = true;
    state.managedMap = { heater: true };
    const base = { configured: true, sourceId: null, sourceReady: true, usedBy: null, sources: [] };
    acceptDevicePowerSetup({ devices: [
      { ...base, id: 'relay', name: 'Relay', lastResortAvailable: true, defaultBinarySwitchAvailable: true },
      { ...base, id: 'heater', name: 'Heater', sourceId: 'gone', sourceReady: false },
      { ...base, id: 'load', name: 'Load', thermostatId: 'gone', thermostats: [] },
    ] });
    const switchDevice = { deviceType: 'onoff' as const, deviceClass: 'socket', powerCapable: false,
      binaryControllable: true, capabilities: ['onoff'] };
    renderDevices([
      buildDevice({ ...switchDevice, id: 'relay', name: 'Relay' }),
      buildDevice({ ...switchDevice, id: 'heater', name: 'Heater' }),
      buildDevice({ ...switchDevice, id: 'load', name: 'Load' }),
    ]);

    expect(document.querySelector('[data-device-id="relay"] .pels-device-card__power-warning')
      ?.getAttribute('aria-label')).toContain('or turn on last-resort control under Power and control');
    expect(document.querySelector('[data-device-id="heater"]')?.textContent)
      .toContain('Metering socket unavailable. Choose another power source under Power and control.');
    expect(document.querySelector('[data-device-id="load"]')?.textContent)
      .toContain('External thermostat unavailable. Check it in Homey or change it under Power and control.');
  });

  it('renders one surface card per device class with managed count chip', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.managedMap = { 'heater-1': true };
    state.controllableMap = {};
    state.priceOptimizationSettings = {};
    state.budgetExemptMap = {};
    state.latestDevices = [
      buildDevice({ id: 'heater-1', name: 'Hall heater', deviceClass: 'heater' }),
      buildDevice({ id: 'heater-2', name: 'Bath heater', deviceClass: 'heater' }),
      buildDevice({ id: 'evcharger-1', name: 'EV', deviceClass: 'evcharger' }),
    ];

    renderDevices(state.latestDevices);

    const cards = document.querySelectorAll<HTMLElement>('#device-card-list .pels-device-card');
    expect(cards.length).toBe(2);
    const heaterCard = Array.from(cards).find(
      (c) => c.dataset.deviceClass === 'heater',
    );
    expect(heaterCard?.querySelector('.plan-card__title')?.textContent).toBe('Heater');
    expect(heaterCard?.querySelector('.pels-device-card__count-chip')?.textContent).toBe(
      '1 of 2 managed',
    );
    expect(heaterCard?.querySelectorAll('.pels-device-card__row').length).toBe(2);
  });

  it('renders three switches per row reflecting managed/limit/price state', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.managedMap = { 'h1': true };
    state.controllableMap = { 'h1': true };
    state.priceOptimizationSettings = {
      'h1': {
        enabled: false,
        cheapDelta: 5,
        expensiveDelta: -5,
        priceConfigured: true,
        surplusWilling: false,
        surplusDelta: 2,
      },
    };
    state.budgetExemptMap = {};
    state.latestDevices = [
      buildDevice({ id: 'h1', name: 'Heater', deviceClass: 'heater', powerCapable: true}),
    ];

    renderDevices(state.latestDevices);

    const row = document.querySelector<HTMLElement>('[data-device-id="h1"]');
    const inputs = row?.querySelectorAll<HTMLButtonElement>('.pels-icon-toggle');
    expect(inputs?.length).toBe(3);
    expect(inputs?.[0]?.getAttribute('aria-checked')).toBe('true'); // managed
    expect(inputs?.[1]?.getAttribute('aria-checked')).toBe('true'); // limit
    expect(inputs?.[2]?.getAttribute('aria-checked')).toBe('false'); // price
  });

  it('disables limit and price switches when device is unmanageable', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.managedMap = {};
    state.controllableMap = {};
    state.priceOptimizationSettings = {};
    state.budgetExemptMap = {};
    // sensor with no temperature target and no power → unmanageable
    state.latestDevices = [
      buildDevice({ id: 'sensor-1', name: 'Sensor', deviceClass: 'sensor', deviceType: undefined, targets: [] }),
    ];

    renderDevices(state.latestDevices);

    const row = document.querySelector<HTMLElement>('[data-device-id="sensor-1"]');
    expect(row?.classList.contains('pels-device-card__row--unmanageable')).toBe(true);
    const inputs = row?.querySelectorAll<HTMLButtonElement>('.pels-icon-toggle');
    inputs?.forEach((input) => expect(input.getAttribute('aria-disabled')).toBe('true'));
  });

  it('opens device detail only from the explicit settings button', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.managedMap = {};
    state.controllableMap = {};
    state.priceOptimizationSettings = {};
    state.budgetExemptMap = {};
    state.latestDevices = [buildDevice({ id: 'h1', name: 'Heater', deviceClass: 'heater' })];

    renderDevices(state.latestDevices);

    const handler = vi.fn();
    document.addEventListener('open-device-detail', handler);

    const nameEl = document.querySelector<HTMLElement>('[data-device-id="h1"] .device-row__title');
    nameEl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handler).not.toHaveBeenCalled();

    const detailButton = document.querySelector<HTMLElement>('[data-device-id="h1"] .pels-device-card__detail-button');
    detailButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handler).toHaveBeenCalled();
    document.removeEventListener('open-device-detail', handler);
  });
});
