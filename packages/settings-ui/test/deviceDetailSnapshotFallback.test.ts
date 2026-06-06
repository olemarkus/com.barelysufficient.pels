// Per-callsite coverage for the snapshot-fallback wiring extended from
// `deviceDetail/index.ts` and `deviceDetail/shedBehavior.ts` to the
// remaining writeFreshSetting callers. The helper itself
// (settingsWrite.ts) and the legacy callers are covered by
// settingsWriteFresh.test.ts, deviceDetailBudgetExempt.test.ts, and
// shedBehaviorFailClosed.test.ts; this file only confirms that each new
// callsite passes its live `state.*` snapshot as the fallback so a
// transient non-object SDK read does not erase entries for other devices.

import type { TargetDeviceSnapshot } from '../../contracts/src/types';
import { createHomeyMock } from './helpers/homeyApiMock';

const flushPromises = () => new Promise<void>((resolve) => {
  setTimeout(() => resolve(), 0);
});

// The device-detail surface is large and the inner-HTML scaffold is the
// established pattern across deviceDetail*.test.ts; the markup is static
// test fixture content (no untrusted input) so a template parse is safe.
const DEVICE_DETAIL_DOM_TEMPLATE = `
  <style>
    .detail-control-list,
    .detail-mode-list,
    .detail-stepped-list,
    .detail-deltas {
      display: block;
    }

    .detail-control-list[hidden],
    .detail-mode-list[hidden],
    .detail-stepped-list[hidden],
    .detail-deltas[hidden] {
      display: none !important;
    }
  </style>
  <div id="toast"></div>
  <div id="device-detail-overlay" hidden>
    <div id="device-detail-panel">
      <div id="device-detail-title"></div>
      <md-text-button id="device-detail-close"></md-text-button>
      <details id="device-detail-setup-disclosure"><summary></summary></details>
      <div id="device-detail-native-wiring-notice" hidden></div>
      <md-text-button id="device-detail-native-wiring-notice-action"></md-text-button>
      <div id="device-detail-native-wiring-row" hidden></div>
      <md-switch id="device-detail-native-wiring"></md-switch>
      <div id="device-detail-native-wiring-confirm-row" hidden></div>
      <md-switch id="device-detail-native-wiring-confirm"></md-switch>
      <md-switch id="device-detail-managed"></md-switch>
      <md-switch id="device-detail-controllable"></md-switch>
      <md-switch id="device-detail-price-opt"></md-switch>
      <md-switch id="device-detail-budget-exempt"></md-switch>
      <div id="device-detail-soc-row" hidden></div>
      <div id="device-detail-soc-updated"></div>
      <div id="device-detail-soc-value"></div>
      <div id="device-detail-control-model-row">
        <md-filled-select id="device-detail-control-model">
          <md-select-option value="default"><div slot="headline">Default</div></md-select-option>
          <md-select-option value="stepped_load"><div slot="headline">Stepped load</div></md-select-option>
          <md-select-option value="continuous"><div slot="headline">Continuous</div></md-select-option>
          <md-select-option value="ev_charger_1_phase"><div slot="headline">EV 1-phase</div></md-select-option>
          <md-select-option value="ev_charger_3_phase"><div slot="headline">EV 3-phase</div></md-select-option>
        </md-filled-select>
      </div>
      <div id="device-detail-modes"></div>
      <div id="device-detail-delta-section"></div>
      <md-filled-text-field id="device-detail-cheap-delta"></md-filled-text-field>
      <md-filled-text-field id="device-detail-expensive-delta"></md-filled-text-field>
      <md-filled-select id="device-detail-overshoot">
        <md-select-option value="turn_off"><div slot="headline">Turn off</div></md-select-option>
        <md-select-option value="set_temperature"><div slot="headline">Set to temperature</div></md-select-option>
        <md-select-option value="set_step"><div slot="headline">Set to step</div></md-select-option>
      </md-filled-select>
      <div id="device-detail-overshoot-temp-row"></div>
      <md-filled-text-field id="device-detail-overshoot-temp"></md-filled-text-field>
      <div id="device-detail-overshoot-step-row"></div>
      <md-filled-select id="device-detail-overshoot-step"></md-filled-select>
      <section id="device-detail-target-power-config" hidden>
        <div id="device-detail-target-power-fields" hidden>
          <md-filled-text-field id="device-detail-target-power-min"></md-filled-text-field>
          <md-filled-text-field id="device-detail-target-power-max"></md-filled-text-field>
          <md-filled-text-field id="device-detail-target-power-step"></md-filled-text-field>
          <md-filled-text-field id="device-detail-target-power-exclude-min"></md-filled-text-field>
          <md-filled-text-field id="device-detail-target-power-exclude-max"></md-filled-text-field>
        </div>
        <md-filled-button id="device-detail-target-power-save"></md-filled-button>
        <md-outlined-button id="device-detail-target-power-clear"></md-outlined-button>
      </section>
      <section id="device-detail-stepped-section" hidden>
        <div id="device-detail-stepped-steps" class="detail-stepped-list"></div>
        <div id="device-detail-temperature-boost" class="detail-control-list detail-stepped-boost" hidden>
          <md-switch id="device-detail-temperature-boost-enabled"></md-switch>
          <div id="device-detail-temperature-boost-below-row"></div>
          <md-filled-text-field id="device-detail-temperature-boost-below"></md-filled-text-field>
        </div>
        <div id="device-detail-ev-boost" class="detail-control-list detail-stepped-boost" hidden>
          <md-switch id="device-detail-ev-boost-enabled"></md-switch>
          <div id="device-detail-ev-boost-below-row"></div>
          <md-filled-text-field id="device-detail-ev-boost-below"></md-filled-text-field>
          <div id="device-detail-ev-boost-status"></div>
        </div>
        <md-outlined-button id="device-detail-stepped-add-step"></md-outlined-button>
        <md-filled-button id="device-detail-stepped-save"></md-filled-button>
        <md-outlined-button id="device-detail-stepped-reset"></md-outlined-button>
      </section>
      <details id="device-detail-diagnostics-disclosure">
        <summary>Advanced diagnostics</summary>
        <div id="device-detail-diagnostics-status"></div>
        <div id="device-detail-diagnostics-cards"></div>
      </details>
    </div>
  </div>
`;

const buildDom = () => {
  const template = document.createElement('template');
  template.innerHTML = DEVICE_DETAIL_DOM_TEMPLATE;
  document.body.replaceChildren(template.content);
};

const buildDevice = (
  id: string,
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id,
  name: id,
  targets: [{ id: 'target_temperature', value: 18, unit: '°C' }],
  deviceType: 'temperature',
  powerCapable: true,
  binaryControl: { on: true },
  capabilities: ['target_temperature', 'onoff'],
  ...overrides,
});

const installCommonMocks = () => {
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
};

describe('device detail snapshot-fallback wiring (defense-in-depth)', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('managedControl preserves other devices on a corrupt managed_devices SDK read', async () => {
    installCommonMocks();

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        managed_devices: { 'other-device': true, 'heater-1': true },
      },
    });
    homeyModule.setHomeyClient(homey);
    // Inject a non-object SDK read so the legacy `fallbackValue: {}`
    // would have synthesised an empty map and erased 'other-device'.
    vi.spyOn(homeyModule, 'getSettingFresh').mockResolvedValueOnce('corrupt-string');

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('heater-1')];
    state.managedMap = { 'other-device': true, 'heater-1': true };
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

    const managedInput = document.querySelector('#device-detail-managed') as (HTMLElement & { selected: boolean; disabled: boolean }) | null;
    managedInput!.selected = false;
    managedInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'managed_devices',
      { 'other-device': true, 'heater-1': false },
      expect.any(Function),
    );
  });

  it('nativeWiring preserves other devices on a corrupt native_ev_wiring_devices SDK read', async () => {
    installCommonMocks();

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        managed_devices: { 'zaptec-1': true },
        native_ev_wiring_devices: { 'other-charger': true, 'zaptec-1': true },
      },
    });
    homeyModule.setHomeyClient(homey);
    // The disable path persists `native_ev_wiring_devices`. Inject a
    // non-object SDK read so a legacy `fallbackValue: {}` would have
    // erased 'other-charger'.
    vi.spyOn(homeyModule, 'getSettingFresh').mockResolvedValueOnce('corrupt-string');

    const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('zaptec-1', {
      deviceClass: 'evcharger',
      deviceType: 'onoff',
      targets: [],
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: true,
        activationRequired: false,
        activationEnabled: true,
      },
      capabilities: ['measure_power', 'charging_button', 'charge_mode'],
      binaryControl: { on: true },
    })];
    state.managedMap = { 'zaptec-1': true };
    state.controllableMap = { 'zaptec-1': true };
    state.budgetExemptMap = {};
    state.nativeWiringMap = { 'other-charger': true, 'zaptec-1': true };
    state.priceOptimizationSettings = {};
    state.capacityPriorities = { Home: { 'zaptec-1': 1 } };
    state.modeTargets = { Home: {} };
    state.activeMode = 'Home';
    state.editingMode = 'Home';

    initDeviceDetailHandlers();
    openDeviceDetail('zaptec-1');
    await flushPromises();

    const nativeWiringInput = document.querySelector('#device-detail-native-wiring') as (HTMLElement & { selected: boolean; disabled: boolean }) | null;
    nativeWiringInput!.selected = false;
    nativeWiringInput!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'native_ev_wiring_devices',
      { 'other-charger': true, 'zaptec-1': false },
      expect.any(Function),
    );
  });

  it('targetPowerConfig preserves other devices on a corrupt device_target_power_configs SDK read', async () => {
    installCommonMocks();

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        device_target_power_configs: {
          'other-charger': {
            enabled: true,
            preset: 'ev_charger_1_phase',
            min: 0,
            max: 7360,
            step: 460,
            excludeMin: 1,
            excludeMax: 1380,
          },
        },
      },
    });
    homeyModule.setHomeyClient(homey);
    vi.spyOn(homeyModule, 'getSettingFresh').mockResolvedValueOnce('corrupt-string');

    const { persistTargetPowerConfig } = await import('../src/ui/deviceDetail/targetPowerConfig.ts');
    const { state } = await import('../src/ui/state.ts');

    state.deviceTargetPowerConfigs = {
      'other-charger': {
        enabled: true,
        preset: 'ev_charger_1_phase',
        min: 0,
        max: 7360,
        step: 460,
        excludeMin: 1,
        excludeMax: 1380,
      },
    };

    await persistTargetPowerConfig({
      deviceId: 'charger-2',
      config: { enabled: true, min: 0, max: 1500, step: 100 },
      refreshOpenDeviceDetail: vi.fn(),
    });

    expect(homey.set).toHaveBeenCalledWith(
      'device_target_power_configs',
      {
        'other-charger': {
          enabled: true,
          preset: 'ev_charger_1_phase',
          min: 0,
          max: 7360,
          step: 460,
          excludeMin: 1,
          excludeMax: 1380,
        },
        'charger-2': { enabled: true, min: 0, max: 1500, step: 100 },
      },
      expect.any(Function),
    );
  });

  it('evBoost preserves other devices on a corrupt ev_boost_settings SDK read', async () => {
    installCommonMocks();

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        ev_boost_settings: {
          'other-charger': { enabled: true, boostBelowPercent: 40 },
        },
      },
    });
    homeyModule.setHomeyClient(homey);
    vi.spyOn(homeyModule, 'getSettingFresh').mockResolvedValueOnce('corrupt-string');

    const {
      initDeviceDetailHandlers,
      loadEvBoostSettings,
      openDeviceDetail,
    } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('charger-1', {
      deviceClass: 'evcharger',
      deviceType: 'onoff',
      controlModel: 'stepped_load',
      targets: [],
      capabilities: ['measure_power', 'evcharger_charging'],
      evChargingState: 'plugged_in_charging',
      stateOfCharge: { percent: 32, status: 'fresh' },
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

    const boostEnabled = document.querySelector('#device-detail-ev-boost-enabled') as (HTMLElement & { selected: boolean }) | null;
    const boostBelow = document.querySelector('#device-detail-ev-boost-below') as (HTMLElement & { value: string }) | null;
    boostBelow!.value = '35';
    boostEnabled!.selected = true;
    boostEnabled!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'ev_boost_settings',
      {
        'other-charger': { enabled: true, boostBelowPercent: 40 },
        'charger-1': { enabled: true, boostBelowPercent: 35 },
      },
      expect.any(Function),
    );
  });

  it('temperatureBoost preserves other devices on a corrupt temperature_boost_settings SDK read', async () => {
    installCommonMocks();

    const homeyModule = await import('../src/ui/homey.ts');
    const homey = createHomeyMock({
      settings: {
        temperature_boost_settings: {
          'other-tank': { enabled: true, boostBelowC: 54 },
        },
      },
    });
    homeyModule.setHomeyClient(homey);
    vi.spyOn(homeyModule, 'getSettingFresh').mockResolvedValueOnce('corrupt-string');

    const {
      initDeviceDetailHandlers,
      loadTemperatureBoostSettings,
      openDeviceDetail,
    } = await import('../src/ui/deviceDetail/index.ts');
    const { state } = await import('../src/ui/state.ts');

    state.latestDevices = [buildDevice('tank-1', {
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

    const boostEnabled = document.querySelector('#device-detail-temperature-boost-enabled') as (HTMLElement & { selected: boolean }) | null;
    const boostBelow = document.querySelector('#device-detail-temperature-boost-below') as (HTMLElement & { value: string }) | null;
    boostBelow!.value = '53';
    boostEnabled!.selected = true;
    boostEnabled!.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'temperature_boost_settings',
      {
        'other-tank': { enabled: true, boostBelowC: 54 },
        'tank-1': { enabled: true, boostBelowC: 53 },
      },
      expect.any(Function),
    );
  });
});
