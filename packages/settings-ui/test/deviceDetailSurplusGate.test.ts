// The per-device "Use solar surplus" control must be HIDDEN unless the home's surplus
// POOL can actually open (state.surplusPoolReachable) AND the device is a temperature
// device. That keeps it out of the no-solar majority's panels, off devices (EV / on-off)
// that cannot self-consume by raising a setpoint, and — the case the pool flag adds — out
// of homes with solar whose net never goes negative, where the runtime declines the
// posture and the toggle would switch on a feature that cannot engage.
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
          <p id="device-detail-surplus-gate-hint" hidden></p>
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

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({ available: true, expectedPowerKw: 1, expectedPowerSource: 'default',
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
  vi.doMock('../src/ui/toast.ts', () => ({ showToast: vi.fn().mockResolvedValue(undefined), showToastError: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
};

const openPanel = async (params: {
  hasManagedSolarDevice: boolean;
  hasExhibitedExport?: boolean;
  /** Defaults to "solar present ⇒ pool reachable", the ordinary home. Set it
   *  explicitly to cover the divergence: solar on the roof, no reachable pool. */
  surplusPoolReachable?: boolean;
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
  state.hasExhibitedExport = params.hasExhibitedExport ?? false;
  state.surplusPoolReachable = params.surplusPoolReachable
    ?? (params.hasManagedSolarDevice || params.hasExhibitedExport === true);
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

  it('shows the surplus row for a meter-only PV home (exhibited export, no solar device)', async () => {
    await openPanel({ hasManagedSolarDevice: false, hasExhibitedExport: true, device: buildDevice() });
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

  it('keeps the section visible but disabled with a hint while the toggle is off', async () => {
    // Suppressed-control treatment: applicable-but-unavailable renders
    // visible-but-disabled + hint, never vanish.
    await openPanel({ hasManagedSolarDevice: true, device: buildDevice() });
    expect(surplusSection()?.style.display).toBe('block');
    const hint = document.querySelector('#device-detail-surplus-gate-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('Use solar surplus');
    const delta = document.querySelector('#device-detail-surplus-delta') as HTMLElement & { disabled?: boolean };
    expect(delta.disabled).toBe(true);
  });

  it('shows the surplus fields whenever the toggle is on, even with no reachable pool', async () => {
    // The escape hatch, mirrored from the row: reachability decides whether the
    // opt-in is OFFERED, but an install that opted in before the gate existed
    // must still be able to see and clear what it stored. Gating the fields
    // again here would leave an invisible persisted setting.
    await openPanel({
      hasManagedSolarDevice: false,
      surplusPoolReachable: false,
      device: buildDevice(),
      surplusWilling: true,
    });
    expect(surplusRow()?.hidden).toBe(false);
    expect(surplusSection()?.style.display).toBe('block');
  });

  it('hides the row on a solar home whose surplus pool can never open', async () => {
    // Solar on the roof, but the whole-home net never goes negative — the state
    // every flow install whose Flow predates signed watts is in. The runtime
    // declines the `surplusOnly` posture there, so offering the toggle would
    // sell a feature that cannot engage.
    await openPanel({
      hasManagedSolarDevice: true,
      surplusPoolReachable: false,
      device: buildDevice(),
    });
    expect(surplusRow()?.hidden).toBe(true);
  });
});
