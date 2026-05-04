import type { TargetDeviceSnapshot } from '../../contracts/src/types';
import { createHomeyMock } from './helpers/homeyApiMock';

const flushPromises = () => new Promise<void>((resolve) => {
  setTimeout(() => resolve(), 0);
});

const buildDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <div id="device-detail-overlay" hidden>
      <div id="device-detail-panel">
        <div id="device-detail-title"></div>
        <button id="device-detail-close"></button>
        <div id="device-detail-native-wiring-row" hidden></div>
        <input id="device-detail-native-wiring" type="checkbox">
        <div id="device-detail-native-wiring-confirm-row" hidden></div>
        <input id="device-detail-native-wiring-confirm" type="checkbox">
        <input id="device-detail-managed" type="checkbox">
        <input id="device-detail-controllable" type="checkbox">
        <input id="device-detail-price-opt" type="checkbox">
        <input id="device-detail-budget-exempt" type="checkbox">
        <div id="device-detail-soc-row" hidden></div>
        <div id="device-detail-soc-updated"></div>
        <div id="device-detail-soc-value"></div>
        <div id="device-detail-control-model-row">
          <select id="device-detail-control-model"></select>
        </div>
        <div id="device-detail-modes"></div>
        <div id="device-detail-delta-section"></div>
        <input id="device-detail-cheap-delta">
        <input id="device-detail-expensive-delta">
        <select id="device-detail-overshoot">
          <option value="turn_off">Turn off</option>
          <option value="set_temperature">Set to temperature</option>
          <option value="set_step">Set to step</option>
        </select>
        <div id="device-detail-overshoot-temp-row"></div>
        <input id="device-detail-overshoot-temp">
        <div id="device-detail-overshoot-step-row"></div>
        <select id="device-detail-overshoot-step"></select>
        <section id="device-detail-stepped-section" hidden>
          <div id="device-detail-stepped-steps"></div>
          <div id="device-detail-temperature-boost">
            <input id="device-detail-temperature-boost-enabled" type="checkbox">
            <div id="device-detail-temperature-boost-below-row"></div>
            <input id="device-detail-temperature-boost-below" type="number">
          </div>
          <div id="device-detail-ev-boost" hidden>
            <input id="device-detail-ev-boost-enabled" type="checkbox">
            <div id="device-detail-ev-boost-below-row"></div>
            <input id="device-detail-ev-boost-below" type="number">
            <div id="device-detail-ev-boost-status"></div>
          </div>
          <button id="device-detail-stepped-add-step" type="button"></button>
          <button id="device-detail-stepped-save" type="button"></button>
          <button id="device-detail-stepped-reset" type="button"></button>
        </section>
        <details id="device-detail-diagnostics-disclosure">
          <summary>Advanced diagnostics</summary>
          <div id="device-detail-diagnostics-status"></div>
          <div id="device-detail-diagnostics-cards"></div>
        </details>
      </div>
    </div>
  `;
};

const buildDevice = (
  id: string,
  name: string,
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id,
  name,
  targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
  deviceType: 'temperature',
  powerCapable: true,
  currentOn: true,
  capabilities: ['target_temperature', 'onoff'],
  ...overrides,
});

describe('device detail managed state saves', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the currently open device panel stable when an earlier managed save resolves late', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        managed_devices: { 'heater-1': true, 'heater-2': false },
      },
    });
    homeyModule.setHomeyClient(homey);

    let resolveFresh: ((value: unknown) => void) | null = null;
    const freshRead = new Promise<unknown>((resolve) => {
      resolveFresh = resolve;
    });
    vi.spyOn(homeyModule, 'getSettingFresh').mockReturnValueOnce(freshRead);

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [
      buildDevice('heater-1', 'Hall Heater'),
      buildDevice('heater-2', 'Bedroom Heater'),
    ];
    state.managedMap = { 'heater-1': true, 'heater-2': false };
    state.controllableMap = { 'heater-1': true, 'heater-2': false };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'heater-1': 1, 'heater-2': 2 } };
    state.modeTargets = {
      Home: { 'heater-1': 20, 'heater-2': 18 },
      Away: { 'heater-1': 16, 'heater-2': 14 },
    };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('heater-1');
    await flushPromises();

    const managedInput = document.querySelector('#device-detail-managed') as HTMLInputElement | null;
    const detailTitle = document.querySelector('#device-detail-title') as HTMLElement | null;

    managedInput!.checked = false;
    managedInput!.dispatchEvent(new Event('change', { bubbles: true }));

    openDeviceDetail('heater-2');
    await flushPromises();
    expect(detailTitle?.textContent).toBe('Bedroom Heater');
    expect(managedInput?.checked).toBe(false);

    resolveFresh!({ 'heater-1': true, 'heater-2': false });
    await flushPromises();
    await flushPromises();

    expect(detailTitle?.textContent).toBe('Bedroom Heater');
    expect(managedInput?.checked).toBe(false);
  });

  it('requires transient confirmation before enabling built-in device control', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        managed_devices: { 'zaptec-1': true },
        native_ev_wiring_devices: {},
      },
    });
    homeyModule.setHomeyClient(homey);

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('zaptec-1', 'Driveway Zaptec', {
      deviceClass: 'evcharger',
      deviceType: 'onoff',
      targets: [],
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: true,
        activationEnabled: false,
      },
      capabilities: ['measure_power', 'charging_button', 'charge_mode', 'alarm_generic.car_connected'],
      currentOn: false,
    })];
    state.managedMap = { 'zaptec-1': true };
    state.controllableMap = { 'zaptec-1': false };
    state.budgetExemptMap = {};
    state.nativeWiringMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'zaptec-1': 1 } };
    state.modeTargets = { Home: {} };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('zaptec-1');
    await flushPromises();

    const nativeWiringInput = document.querySelector('#device-detail-native-wiring') as HTMLInputElement | null;
    const confirmRow = document.querySelector('#device-detail-native-wiring-confirm-row') as HTMLElement | null;
    const confirmInput = document.querySelector('#device-detail-native-wiring-confirm') as HTMLInputElement | null;
    const managedInput = document.querySelector('#device-detail-managed') as HTMLInputElement | null;
    const controlModelRow = document.querySelector('#device-detail-control-model-row') as HTMLElement | null;

    expect(nativeWiringInput?.checked).toBe(false);
    expect(confirmRow?.hidden).toBe(true);
    expect(managedInput?.disabled).toBe(true);
    expect(controlModelRow?.hidden).toBe(true);

    nativeWiringInput!.checked = true;
    nativeWiringInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(confirmRow?.hidden).toBe(false);
    expect(homey.set).not.toHaveBeenCalledWith('native_ev_wiring_devices', expect.anything(), expect.any(Function));

    confirmInput!.checked = true;
    confirmInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'native_ev_wiring_devices',
      { 'zaptec-1': true },
      expect.any(Function),
    );
    expect(state.nativeWiringMap['zaptec-1']).toBe(true);
    expect(managedInput?.disabled).toBe(false);

    nativeWiringInput!.checked = false;
    nativeWiringInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'native_ev_wiring_devices',
      { 'zaptec-1': false },
      expect.any(Function),
    );
    expect(homey.set).toHaveBeenCalledWith(
      'managed_devices',
      { 'zaptec-1': false },
      expect.any(Function),
    );
    const managedDisableCall = homey.set.mock.calls.findIndex(([key, value]) => (
      key === 'managed_devices' && (value as Record<string, boolean>)['zaptec-1'] === false
    ));
    const nativeDisableCall = homey.set.mock.calls.findIndex(([key, value]) => (
      key === 'native_ev_wiring_devices' && (value as Record<string, boolean>)['zaptec-1'] === false
    ));
    expect(managedDisableCall).toBeGreaterThanOrEqual(0);
    expect(nativeDisableCall).toBeGreaterThanOrEqual(0);
    expect(managedDisableCall).toBeLessThan(nativeDisableCall);
    expect(state.managedMap['zaptec-1']).toBe(false);
  });

  it('clears stale managed state when built-in device control is already off', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        managed_devices: { 'zaptec-1': true },
        native_ev_wiring_devices: {},
      },
    });
    homeyModule.setHomeyClient(homey);

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('zaptec-1', 'Driveway Zaptec', {
      deviceClass: 'evcharger',
      deviceType: 'onoff',
      targets: [],
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: true,
        activationEnabled: false,
      },
      capabilities: ['measure_power', 'charging_button', 'charge_mode', 'alarm_generic.car_connected'],
      currentOn: false,
    })];
    state.managedMap = { 'zaptec-1': true };
    state.controllableMap = { 'zaptec-1': false };
    state.budgetExemptMap = {};
    state.nativeWiringMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'zaptec-1': 1 } };
    state.modeTargets = { Home: {} };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('zaptec-1');
    await flushPromises();

    const nativeWiringInput = document.querySelector('#device-detail-native-wiring') as HTMLInputElement | null;
    const confirmRow = document.querySelector('#device-detail-native-wiring-confirm-row') as HTMLElement | null;

    nativeWiringInput!.checked = true;
    nativeWiringInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(confirmRow?.hidden).toBe(false);

    nativeWiringInput!.checked = false;
    nativeWiringInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'managed_devices',
      { 'zaptec-1': false },
      expect.any(Function),
    );
    expect(homey.set).not.toHaveBeenCalledWith(
      'native_ev_wiring_devices',
      { 'zaptec-1': false },
      expect.any(Function),
    );
    expect(state.managedMap['zaptec-1']).toBe(false);
    expect(confirmRow?.hidden).toBe(true);
  });

  it('shows EV SoC details for charger device detail', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(createHomeyMock({ settings: { managed_devices: { 'ev-1': true } } }));

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');
    state.latestDevices = [buildDevice('ev-1', 'Driveway Charger', {
      deviceClass: 'evcharger',
      deviceType: 'onoff',
      targets: [],
      stateOfCharge: {
        percent: 42,
        observedAtMs: Date.parse('2026-03-11T10:00:00Z'),
        status: 'stale',
        source: 'flow',
        sourceLabel: 'Tesla Flow',
      },
    })];
    state.managedMap = { 'ev-1': true };
    state.controllableMap = { 'ev-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'ev-1': 1 } };
    state.modeTargets = { Home: {} };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('ev-1');
    await flushPromises();

    expect((document.querySelector('#device-detail-soc-row') as HTMLElement | null)?.hidden).toBe(false);
    expect((document.querySelector('#device-detail-soc-value') as HTMLElement | null)?.textContent)
      .toBe('42 % from Tesla Flow - stale');
    expect((document.querySelector('#device-detail-soc-updated') as HTMLElement | null)?.textContent)
      .toContain('Status: stale');
  });

  it('restores the controllable checkbox when saving fails', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        controllable_devices: { 'heater-1': true },
      },
    });
    homeyModule.setHomeyClient(homey);
    vi.spyOn(homeyModule, 'getSettingFresh').mockRejectedValueOnce(new Error('Homey SDK not ready'));

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('heater-1', 'Hall Heater')];
    state.managedMap = { 'heater-1': true };
    state.controllableMap = { 'heater-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'heater-1': 1 } };
    state.modeTargets = { Home: { 'heater-1': 20 } };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('heater-1');
    await flushPromises();

    const controllableInput = document.querySelector('#device-detail-controllable') as HTMLInputElement | null;
    expect(controllableInput?.checked).toBe(true);

    controllableInput!.checked = false;
    controllableInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(controllableInput?.checked).toBe(true);
    expect(state.controllableMap['heater-1']).toBe(true);
  });

  it('restores the managed checkbox when saving fails', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        managed_devices: { 'heater-1': true },
      },
    });
    homeyModule.setHomeyClient(homey);
    vi.spyOn(homeyModule, 'getSettingFresh').mockRejectedValueOnce(new Error('Homey SDK not ready'));

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('heater-1', 'Hall Heater')];
    state.managedMap = { 'heater-1': true };
    state.controllableMap = { 'heater-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'heater-1': 1 } };
    state.modeTargets = { Home: { 'heater-1': 20 } };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('heater-1');
    await flushPromises();

    const managedInput = document.querySelector('#device-detail-managed') as HTMLInputElement | null;
    expect(managedInput?.checked).toBe(true);

    managedInput!.checked = false;
    managedInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(managedInput?.checked).toBe(true);
    expect(state.managedMap['heater-1']).toBe(true);
  });

  it('keeps the delta section state tied to the currently open device when an earlier price-opt save resolves late', async () => {
    const savePriceOptimizationSettings = vi.fn<() => Promise<void>>();
    let resolveSave: (() => void) | null = null;
    savePriceOptimizationSettings.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));

    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings,
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    homeyModule.setHomeyClient(createHomeyMock());

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [
      buildDevice('heater-1', 'Hall Heater'),
      buildDevice('heater-2', 'Bedroom Heater'),
    ];
    state.managedMap = { 'heater-1': false, 'heater-2': true };
    state.controllableMap = { 'heater-1': false, 'heater-2': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {
      'heater-1': { enabled: false, cheapDelta: 5, expensiveDelta: -5 },
      'heater-2': { enabled: true, cheapDelta: 4, expensiveDelta: -4 },
    };
    state.capacityPriorities = { Home: { 'heater-1': 1, 'heater-2': 2 } };
    state.modeTargets = {
      Home: { 'heater-1': 20, 'heater-2': 18 },
      Away: { 'heater-1': 16, 'heater-2': 14 },
    };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('heater-1');
    await flushPromises();

    const cheapDeltaInput = document.querySelector('#device-detail-cheap-delta') as HTMLInputElement | null;
    const deltaSection = document.querySelector('#device-detail-delta-section') as HTMLElement | null;

    cheapDeltaInput!.value = '6';
    cheapDeltaInput!.dispatchEvent(new Event('change', { bubbles: true }));

    openDeviceDetail('heater-2');
    await flushPromises();
    expect(deltaSection?.style.display).toBe('block');

    resolveSave!();
    await flushPromises();
    await flushPromises();

    expect(deltaSection?.style.display).toBe('block');
  });

  it('restores the control model when saving the profile fails', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const controlModelInput = document.querySelector('#device-detail-control-model') as HTMLSelectElement | null;
    controlModelInput!.innerHTML = `
      <option value="temperature_target">Temperature target</option>
      <option value="stepped_load">Stepped load</option>
    `;

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        device_control_profiles: {},
      },
    });
    const originalSet = homey.set;
    homey.set = vi.fn((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key === 'device_control_profiles') {
        cb?.(new Error('Homey SDK not ready'));
        return;
      }
      originalSet(key, value, cb);
    });
    homeyModule.setHomeyClient(homey);

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('heater-1', 'Hall Heater')];
    state.managedMap = { 'heater-1': true };
    state.controllableMap = { 'heater-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'heater-1': 1 } };
    state.modeTargets = { Home: { 'heater-1': 20 } };
    state.deviceControlProfiles = {};
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('heater-1');
    await flushPromises();

    expect(controlModelInput?.value).toBe('default');

    controlModelInput!.value = 'stepped_load';
    controlModelInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(controlModelInput?.value).toBe('default');
    expect(state.deviceControlProfiles['heater-1']).toBeUndefined();
    expect(homey.__settingsStore.device_control_profiles).toEqual({});
  });

  it('does not refresh another device panel when an earlier control-model save fails late', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const controlModelInput = document.querySelector('#device-detail-control-model') as HTMLSelectElement | null;
    controlModelInput!.innerHTML = `
      <option value="temperature_target">Temperature target</option>
      <option value="stepped_load">Stepped load</option>
    `;

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        device_control_profiles: {},
      },
    });
    let rejectFirstProfileSave: (() => void) | null = null;
    homey.set = vi.fn((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key === 'device_control_profiles') {
        rejectFirstProfileSave = () => {
          cb?.(new Error('Homey SDK not ready'));
        };
        return;
      }
      homey.__settingsStore[key] = value;
      cb?.(null);
    });
    homeyModule.setHomeyClient(homey);

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [
      buildDevice('heater-1', 'Hall Heater'),
      buildDevice('heater-2', 'Bedroom Heater'),
    ];
    state.managedMap = { 'heater-1': true, 'heater-2': true };
    state.controllableMap = { 'heater-1': true, 'heater-2': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {
      'heater-1': { enabled: false, cheapDelta: 5, expensiveDelta: -5 },
      'heater-2': { enabled: true, cheapDelta: 4, expensiveDelta: -4 },
    };
    state.capacityPriorities = { Home: { 'heater-1': 1, 'heater-2': 2 } };
    state.modeTargets = {
      Home: { 'heater-1': 20, 'heater-2': 18 },
    };
    state.deviceControlProfiles = {};
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();

    openDeviceDetail('heater-1');
    await flushPromises();
    controlModelInput!.value = 'stepped_load';
    controlModelInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    openDeviceDetail('heater-2');
    await flushPromises();

    const detailTitle = document.querySelector('#device-detail-title') as HTMLElement | null;
    const cheapDeltaInput = document.querySelector('#device-detail-cheap-delta') as HTMLInputElement | null;
    cheapDeltaInput!.value = '99';

    rejectFirstProfileSave!();
    await flushPromises();
    await flushPromises();

    expect(detailTitle?.textContent).toBe('Bedroom Heater');
    expect(cheapDeltaInput?.value).toBe('99');
  });

  it('locks stepped-load profile editing to device-supported steps when native wiring is enabled', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const controlModelInput = document.querySelector('#device-detail-control-model') as HTMLSelectElement | null;
    controlModelInput!.innerHTML = `
      <option value="temperature_target">Temperature target</option>
      <option value="stepped_load">Stepped load</option>
    `;

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        device_control_profiles: {
          'hoiax-1': {
            model: 'stepped_load',
            steps: [
              { id: 'off', planningPowerW: 0 },
              { id: 'eco', planningPowerW: 900 },
              { id: 'boost', planningPowerW: 4000 },
            ],
          },
        },
      },
    });
    homeyModule.setHomeyClient(homey);

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('hoiax-1', 'Connected 300', {
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: true,
        activationRequired: false,
        activationEnabled: true,
      },
      suggestedSteppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'medium', planningPowerW: 1750 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    })];
    state.managedMap = { 'hoiax-1': true };
    state.controllableMap = { 'hoiax-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'hoiax-1': 1 } };
    state.modeTargets = { Home: { 'hoiax-1': 20 } };
    state.deviceControlProfiles = homey.__settingsStore.device_control_profiles as typeof state.deviceControlProfiles;
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('hoiax-1');
    await flushPromises();

    const stepIds = Array.from(
      document.querySelectorAll('#device-detail-stepped-steps [data-step-field="id"]'),
    ) as HTMLInputElement[];
    const planningInputs = Array.from(
      document.querySelectorAll('#device-detail-stepped-steps [data-step-field="planningPowerW"]'),
    ) as HTMLInputElement[];
    const addButton = document.querySelector('#device-detail-stepped-add-step') as HTMLButtonElement | null;
    const resetButton = document.querySelector('#device-detail-stepped-reset') as HTMLButtonElement | null;
    const saveButton = document.querySelector('#device-detail-stepped-save') as HTMLButtonElement | null;
    const removeButtons = Array.from(
      document.querySelectorAll('#device-detail-stepped-steps button'),
    ) as HTMLButtonElement[];

    expect(controlModelInput?.value).toBe('stepped_load');
    expect(controlModelInput?.disabled).toBe(true);
    expect(stepIds.map((input) => input.value)).toEqual(['off', 'low', 'medium', 'max']);
    expect(planningInputs.map((input) => input.value)).toEqual(['0', '1250', '1750', '3000']);
    expect(stepIds.every((input) => input.disabled)).toBe(true);
    expect(planningInputs.every((input) => input.disabled)).toBe(true);
    expect(removeButtons.every((button) => button.disabled)).toBe(true);
    expect(addButton?.disabled).toBe(true);
    expect(resetButton?.disabled).toBe(true);
    expect(saveButton?.disabled).toBe(true);

    saveButton?.dispatchEvent(new Event('click', { bubbles: true }));
    controlModelInput!.value = 'default';
    controlModelInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(homey.set).not.toHaveBeenCalledWith('device_control_profiles', expect.anything(), expect.any(Function));
    expect(controlModelInput?.value).toBe('stepped_load');
  });

  it('limits native EV wiring control modes to default and EV presets', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        device_control_profiles: {},
        device_target_power_configs: {},
      },
    });
    homeyModule.setHomeyClient(homey);

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('zaptec-1', 'Driveway Zaptec', {
      deviceClass: 'evcharger',
      deviceType: 'onoff',
      targets: [],
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: true,
        activationEnabled: true,
      },
      controlCapabilityId: 'evcharger_charging',
      controlWriteCapabilityId: 'charging_button',
      capabilities: ['measure_power', 'evcharger_charging', 'available_installation_current', 'charging_button'],
      currentOn: true,
    })];
    state.managedMap = { 'zaptec-1': true };
    state.controllableMap = { 'zaptec-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'zaptec-1': 1 } };
    state.modeTargets = { Home: {} };
    state.deviceControlProfiles = {};
    state.deviceTargetPowerConfigs = {};
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('zaptec-1');
    await flushPromises();

    const controlModelInput = document.querySelector('#device-detail-control-model') as HTMLSelectElement | null;
    const shedActionInput = document.querySelector('#device-detail-overshoot') as HTMLSelectElement | null;
    const steppedSection = document.querySelector('#device-detail-stepped-section') as HTMLElement | null;
    expect(Array.from(controlModelInput?.options ?? []).map((option) => option.value)).toEqual([
      'default',
      'ev_charger_1_phase',
      'ev_charger_3_phase',
    ]);
    expect(controlModelInput?.value).toBe('default');

    controlModelInput!.value = 'ev_charger_1_phase';
    controlModelInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(homey.__settingsStore.device_control_profiles).toEqual({});
    expect(homey.__settingsStore.device_target_power_configs).toEqual({
      'zaptec-1': {
        enabled: true,
        preset: 'ev_charger_1_phase',
        min: 0,
        max: 7360,
        step: 460,
        excludeMin: 1,
        excludeMax: 1380,
      },
    });
    expect(controlModelInput?.value).toBe('ev_charger_1_phase');
    expect(steppedSection?.hidden).toBe(true);
    expect(shedActionInput?.value).toBe('turn_off');
    expect(shedActionInput?.disabled).toBe(false);
    expect(shedActionInput?.querySelector<HTMLOptionElement>('option[value="set_step"]')?.hidden).toBe(true);
  });

  it('serializes control-model saves so concurrent devices do not lose earlier updates', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const controlModelInput = document.querySelector('#device-detail-control-model') as HTMLSelectElement | null;
    controlModelInput!.innerHTML = `
      <option value="temperature_target">Temperature target</option>
      <option value="stepped_load">Stepped load</option>
    `;

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        device_control_profiles: {},
      },
    });
    const originalSet = homey.set;
    let resolveFirstSet: (() => void) | null = null;
    let isFirstProfileSave = true;
    homey.set = vi.fn((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key !== 'device_control_profiles') {
        originalSet(key, value, cb);
        return;
      }
      if (isFirstProfileSave) {
        isFirstProfileSave = false;
        resolveFirstSet = () => {
          homey.__settingsStore[key] = value;
          cb?.(null);
        };
        return;
      }
      homey.__settingsStore[key] = value;
      cb?.(null);
    });
    homeyModule.setHomeyClient(homey);

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [
      buildDevice('heater-1', 'Hall Heater'),
      buildDevice('heater-2', 'Bedroom Heater'),
    ];
    state.managedMap = { 'heater-1': true, 'heater-2': true };
    state.controllableMap = { 'heater-1': true, 'heater-2': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'heater-1': 1, 'heater-2': 2 } };
    state.modeTargets = {
      Home: { 'heater-1': 20, 'heater-2': 19 },
    };
    state.deviceControlProfiles = {};
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();

    openDeviceDetail('heater-1');
    await flushPromises();
    controlModelInput!.value = 'stepped_load';
    controlModelInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    openDeviceDetail('heater-2');
    await flushPromises();
    controlModelInput!.value = 'stepped_load';
    controlModelInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(homey.__settingsStore.device_control_profiles).toEqual({});

    resolveFirstSet!();
    await flushPromises();
    await flushPromises();

    expect(Object.keys(homey.__settingsStore.device_control_profiles as Record<string, unknown>).sort()).toEqual([
      'heater-1',
      'heater-2',
    ]);
  });

  it('shows and saves temperature boost settings for stepped temperature devices', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        temperature_boost_settings: {},
      },
    });
    homeyModule.setHomeyClient(homey);

    const {
      initDeviceDetailHandlers,
      loadTemperatureBoostSettings,
      openDeviceDetail,
    } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('tank-1', 'Water tank', {
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    })];
    state.managedMap = { 'tank-1': true };
    state.controllableMap = { 'tank-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'tank-1': 1 } };
    state.modeTargets = { Home: { 'tank-1': 65 } };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    await loadTemperatureBoostSettings();
    initDeviceDetailHandlers();
    openDeviceDetail('tank-1');
    await flushPromises();

    const boostSection = document.querySelector('#device-detail-temperature-boost') as HTMLElement | null;
    const boostEnabled = document.querySelector('#device-detail-temperature-boost-enabled') as HTMLInputElement | null;
    const boostBelow = document.querySelector('#device-detail-temperature-boost-below') as HTMLInputElement | null;

    expect(boostSection?.hidden).toBe(false);
    expect(boostEnabled?.checked).toBe(false);
    expect(boostBelow?.value).toBe('55');

    boostBelow!.value = '54';
    boostEnabled!.checked = true;
    boostEnabled!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(homey.__settingsStore.temperature_boost_settings).toEqual({
      'tank-1': { enabled: true, boostBelowC: 54 },
    });
  });

  it('hides temperature boost for stepped devices without target temperature capability', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        temperature_boost_settings: {
          'tank-1': { enabled: true, boostBelowC: 54 },
        },
      },
    });
    homeyModule.setHomeyClient(homey);

    const {
      initDeviceDetailHandlers,
      loadTemperatureBoostSettings,
      openDeviceDetail,
    } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('tank-1', 'Water tank', {
      targets: [],
      capabilities: ['onoff'],
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    })];
    state.managedMap = { 'tank-1': true };
    state.controllableMap = { 'tank-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'tank-1': 1 } };
    state.modeTargets = { Home: { 'tank-1': 65 } };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    await loadTemperatureBoostSettings();
    initDeviceDetailHandlers();
    openDeviceDetail('tank-1');
    await flushPromises();

    const boostSection = document.querySelector('#device-detail-temperature-boost') as HTMLElement | null;
    expect(boostSection?.hidden).toBe(true);
  });

  it('shows and saves EV boost settings for stepped EV chargers', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        ev_boost_settings: {},
      },
    });
    homeyModule.setHomeyClient(homey);

    const {
      initDeviceDetailHandlers,
      loadEvBoostSettings,
      openDeviceDetail,
    } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('charger-1', 'Driveway charger', {
      deviceClass: 'evcharger',
      deviceType: 'onoff',
      controlModel: 'stepped_load',
      targets: [],
      evChargingState: 'plugged_in_charging',
      stateOfCharge: {
        percent: 32,
        status: 'fresh',
        source: 'flow',
      },
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    })];
    state.managedMap = { 'charger-1': true };
    state.controllableMap = { 'charger-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'charger-1': 1 } };
    state.modeTargets = { Home: {} };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    await loadEvBoostSettings();
    initDeviceDetailHandlers();
    openDeviceDetail('charger-1');
    await flushPromises();

    const boostSection = document.querySelector('#device-detail-ev-boost') as HTMLElement | null;
    const boostEnabled = document.querySelector('#device-detail-ev-boost-enabled') as HTMLInputElement | null;
    const boostBelow = document.querySelector('#device-detail-ev-boost-below') as HTMLInputElement | null;

    expect(boostSection?.hidden).toBe(false);
    expect(boostEnabled?.checked).toBe(false);
    expect(boostBelow?.value).toBe('40');

    boostBelow!.value = '35';
    boostEnabled!.checked = true;
    boostEnabled!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(homey.__settingsStore.ev_boost_settings).toEqual({
      'charger-1': { enabled: true, boostBelowPercent: 35 },
    });
  });

  it('hides EV boost for non-EV stepped loads', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        ev_boost_settings: {
          'tank-1': { enabled: true, boostBelowPercent: 40 },
        },
      },
    });
    homeyModule.setHomeyClient(homey);

    const {
      initDeviceDetailHandlers,
      loadEvBoostSettings,
      openDeviceDetail,
    } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('tank-1', 'Water tank', {
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    })];
    state.managedMap = { 'tank-1': true };
    state.controllableMap = { 'tank-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'tank-1': 1 } };
    state.modeTargets = { Home: { 'tank-1': 65 } };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    await loadEvBoostSettings();
    initDeviceDetailHandlers();
    openDeviceDetail('tank-1');
    await flushPromises();

    const boostSection = document.querySelector('#device-detail-ev-boost') as HTMLElement | null;
    expect(boostSection?.hidden).toBe(true);
  });

  it('shows EV boost status from the charger SoC state', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({
      renderDevices: vi.fn(),
    }));
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
    }));

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        ev_boost_settings: {
          'charger-1': { enabled: true, boostBelowPercent: 40 },
        },
      },
    });
    homeyModule.setHomeyClient(homey);

    const {
      initDeviceDetailHandlers,
      loadEvBoostSettings,
      openDeviceDetail,
    } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('charger-1', 'Driveway charger', {
      deviceClass: 'evcharger',
      deviceType: 'onoff',
      controlModel: 'stepped_load',
      targets: [],
      evChargingState: 'plugged_in_paused',
      stateOfCharge: {
        percent: 32,
        status: 'stale',
        source: 'flow',
      },
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    })];
    state.managedMap = { 'charger-1': true };
    state.controllableMap = { 'charger-1': true };
    state.budgetExemptMap = {};
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'charger-1': 1 } };
    state.modeTargets = { Home: {} };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    await loadEvBoostSettings();
    initDeviceDetailHandlers();
    openDeviceDetail('charger-1');
    await flushPromises();

    const status = document.querySelector('#device-detail-ev-boost-status') as HTMLElement | null;
    expect(status?.textContent).toBe('Battery level is stale. Boost will not activate.');
  });
});
