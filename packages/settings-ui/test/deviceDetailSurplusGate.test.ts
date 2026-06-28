// The per-device "Use solar surplus" control is solar-only: it must be HIDDEN unless the
// home has a tracked solar/PV device (state.hasManagedSolarDevice) AND the device is a
// temperature device. This keeps it out of the no-solar majority's panels and off devices
// (EV / on-off) that cannot self-consume by raising a setpoint.
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
        <details id="device-detail-setup-disclosure"><summary></summary></details>
        <div id="device-detail-native-wiring-row" hidden></div>
        <md-switch id="device-detail-native-wiring"></md-switch>
        <div id="device-detail-native-wiring-confirm-row" hidden></div>
        <md-switch id="device-detail-native-wiring-confirm"></md-switch>
        <md-switch id="device-detail-managed"></md-switch>
        <md-switch id="device-detail-controllable"></md-switch>
        <md-switch id="device-detail-price-opt"></md-switch>
        <div class="md-switch-row" id="device-detail-surplus-opt-row" hidden>
          <md-switch id="device-detail-surplus-opt"></md-switch>
        </div>
        <section id="device-detail-surplus-section" style="display:none">
          <md-filled-text-field id="device-detail-surplus-delta"></md-filled-text-field>
        </section>
        <md-switch id="device-detail-budget-exempt"></md-switch>
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
  binaryControl: { on: true },
  capabilities: ['target_temperature', 'onoff'],
  ...overrides,
});

const mockSiblings = () => {
  vi.doMock('../src/ui/devices.ts', () => ({ renderDevices: vi.fn() }));
  vi.doMock('../src/ui/modes.ts', () => ({ renderPriorities: vi.fn() }));
  vi.doMock('../src/ui/priceOptimization.ts', () => ({
    renderPriceOptimization: vi.fn(),
    savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/ui/toast.ts', () => ({ showToastError: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
};

const openPanel = async (params: {
  hasManagedSolarDevice: boolean;
  device: TargetDeviceSnapshot;
  surplusWilling?: boolean;
}) => {
  const homeyModule = await import('../src/ui/homey.ts');
  homeyModule.setHomeyClient(createHomeyMock());
  const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
  const { state, defaultPriceOptimizationConfig } = await import('../src/ui/state.ts');

  state.latestDevices = [params.device];
  state.managedMap = { 'heater-1': true };
  state.controllableMap = { 'heater-1': true };
  state.budgetExemptMap = {};
  state.priceOptimizationSettings = params.surplusWilling
    ? { 'heater-1': { ...defaultPriceOptimizationConfig, surplusWilling: true } }
    : {};
  state.hasManagedSolarDevice = params.hasManagedSolarDevice;
  state.capacityPriorities = { Home: { 'heater-1': 1 } };
  state.modeTargets = { Home: { 'heater-1': 20 } };
  state.activeMode = 'Home';
  state.editingMode = 'Home';

  initDeviceDetailHandlers();
  openDeviceDetail('heater-1');
  await flushPromises();
};

const surplusRow = () => document.querySelector('#device-detail-surplus-opt-row') as HTMLElement | null;
const surplusSection = () => document.querySelector('#device-detail-surplus-section') as HTMLElement | null;

describe('device detail "Use solar surplus" gating', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    mockSiblings();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('hides the surplus row when the home has no tracked solar device', async () => {
    await openPanel({ hasManagedSolarDevice: false, device: buildDevice() });
    expect(surplusRow()?.hidden).toBe(true);
  });

  it('shows the surplus row on a managed temperature device when solar is present', async () => {
    await openPanel({ hasManagedSolarDevice: true, device: buildDevice() });
    expect(surplusRow()?.hidden).toBe(false);
  });

  it('hides the surplus row on a non-temperature device even when solar is present', async () => {
    await openPanel({ hasManagedSolarDevice: true, device: buildDevice({ deviceType: 'onoff', capabilities: ['onoff'], targets: [] }) });
    expect(surplusRow()?.hidden).toBe(true);
  });

  it('reveals the surplus section only when solar is present and the toggle is on', async () => {
    await openPanel({ hasManagedSolarDevice: true, device: buildDevice(), surplusWilling: true });
    expect(surplusSection()?.style.display).toBe('block');
  });

  it('keeps the surplus section hidden when the toggle is on but no solar device is present', async () => {
    await openPanel({ hasManagedSolarDevice: false, device: buildDevice(), surplusWilling: true });
    expect(surplusSection()?.style.display).toBe('none');
  });
});
