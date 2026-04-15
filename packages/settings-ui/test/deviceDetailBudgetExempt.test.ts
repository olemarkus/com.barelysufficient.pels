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
        <input id="device-detail-managed" type="checkbox">
        <input id="device-detail-controllable" type="checkbox">
        <input id="device-detail-price-opt" type="checkbox">
        <input id="device-detail-budget-exempt" type="checkbox">
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
        </select>
        <div id="device-detail-overshoot-temp-row"></div>
        <input id="device-detail-overshoot-temp">
        <div id="device-detail-overshoot-step-row"></div>
        <select id="device-detail-overshoot-step"></select>
        <section id="device-detail-stepped-section" hidden>
          <div id="device-detail-stepped-steps"></div>
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

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Hall Heater',
  targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
  deviceType: 'temperature',
  powerCapable: true,
  currentOn: true,
  capabilities: ['target_temperature', 'onoff'],
  ...overrides,
});

describe('device detail budget exemption', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads and saves budget exempt status from the device detail panel', async () => {
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
        budget_exempt_devices: { 'heater-1': true },
      },
    });
    homeyModule.setHomeyClient(homey);
    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice()];
    state.managedMap = { 'heater-1': true };
    state.controllableMap = { 'heater-1': true };
    state.budgetExemptMap = { 'heater-1': true };
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'heater-1': 1 } };
    state.modeTargets = { Home: { 'heater-1': 20 } };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('heater-1');
    await flushPromises();

    const budgetExemptInput = document.querySelector('#device-detail-budget-exempt') as HTMLInputElement | null;
    expect(budgetExemptInput).not.toBeNull();
    expect(budgetExemptInput?.checked).toBe(true);

    budgetExemptInput!.checked = false;
    budgetExemptInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'budget_exempt_devices',
      {},
      expect.any(Function),
    );
    expect(state.budgetExemptMap['heater-1']).toBeUndefined();
  });

  it('prefers the device snapshot when the budget exempt map is still empty', async () => {
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
    const homey = createHomeyMock();
    homeyModule.setHomeyClient(homey);
    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice({ budgetExempt: true })];
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

    const budgetExemptInput = document.querySelector('#device-detail-budget-exempt') as HTMLInputElement | null;
    expect(budgetExemptInput?.checked).toBe(true);
  });

  it('merges budget exempt updates with the latest persisted map', async () => {
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
        budget_exempt_devices: { 'other-device': true },
      },
    });
    homeyModule.setHomeyClient(homey);
    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice({ budgetExempt: false })];
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

    const budgetExemptInput = document.querySelector('#device-detail-budget-exempt') as HTMLInputElement | null;
    expect(budgetExemptInput?.checked).toBe(false);

    budgetExemptInput!.checked = true;
    budgetExemptInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'budget_exempt_devices',
      { 'other-device': true, 'heater-1': true },
      expect.any(Function),
    );
    expect(state.budgetExemptMap).toEqual({ 'other-device': true, 'heater-1': true });
  });
});
