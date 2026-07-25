// The per-device "Leave off until turned on again" control is offered only for
// devices PELS can actually switch — i.e. ones with a binary control capability,
// which is exactly what the runtime detection requires (`isBinaryPlanDevice`).
// Power metadata is NOT the gate: a temperature-only or step-only device reports
// power while having no binary handle, and offering the switch there would
// persist a setting that can never take effect.
//
// The switch is additionally disabled — with a visible "why" — while Managed or
// Power-limit control is off, and warns (without blocking) while a smart task is
// active, since an explicit off action is meant to beat a smart task.
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
        <div class="md-switch-row" id="device-detail-respect-external-off-row" hidden>
          <md-switch id="device-detail-respect-external-off"></md-switch>
          <small class="field__hint" id="device-detail-respect-external-off-power-limit-hint" hidden>Turn on Power-limit control above first — this setting applies when PELS controls whether the device runs.</small>
          <small class="field__hint" id="device-detail-respect-external-off-smart-task-hint" hidden>A Smart task may not finish on time while this device stays off.</small>
        </div>
        <md-switch id="device-detail-price-opt"></md-switch>
        <div class="md-switch-row" id="device-detail-surplus-opt-row" hidden>
          <md-switch id="device-detail-surplus-opt"></md-switch>
        </div>
        <div class="md-switch-row" id="device-detail-dump-load-row" hidden>
          <md-switch id="device-detail-dump-load-opt"></md-switch>
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

const buildBinaryDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Water heater',
  targets: [],
  deviceType: 'onoff',
  deviceClass: 'socket',
  powerCapable: true,
  binaryControl: { on: true },
  controlCapabilityId: 'onoff',
  capabilities: ['onoff'],
  ...overrides,
}) as TargetDeviceSnapshot;

const mockSiblings = () => {
  vi.doMock('../src/ui/devices.ts', () => ({ renderDevices: vi.fn() }));
  vi.doMock('../src/ui/modes.ts', () => ({ renderPriorities: vi.fn() }));
  vi.doMock('../src/ui/priceOptimization.ts', () => ({
    renderPriceOptimization: vi.fn(),
    savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/ui/toast.ts', () => ({
    showToast: vi.fn().mockResolvedValue(undefined),
    showToastError: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
};

type OpenPanelParams = {
  device: TargetDeviceSnapshot;
  managed?: boolean;
  controllable?: boolean;
  optedIn?: boolean;
  activeSmartTask?: boolean;
  storedOptInMap?: Record<string, unknown>;
};

const openPanel = async (params: OpenPanelParams) => {
  const homeyModule = await import('../src/ui/homey.ts');
  const homey = createHomeyMock(params.storedOptInMap
    ? { settings: { respect_external_off_devices: params.storedOptInMap } }
    : {});
  homeyModule.setHomeyClient(homey);
  const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
  const { state } = await import('../src/ui/state.ts');

  const deviceId = params.device.id;
  state.latestDevices = [params.device];
  state.managedMap = { [deviceId]: params.managed ?? true };
  state.controllableMap = { [deviceId]: params.controllable ?? true };
  state.budgetExemptMap = {};
  state.respectExternalOffMap = params.optedIn ? { [deviceId]: true } : {};
  state.priceOptimizationSettings = {};
  state.capacityPriorities = { Home: { [deviceId]: 1 } };
  state.modeTargets = { Home: {} };
  state.activeMode = 'Home';
  state.editingMode = 'Home';
  if (params.activeSmartTask) {
    state.deferredObjectiveSettings = {
      version: 1,
      objectivesByDeviceId: {
        [deviceId]: {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: Date.now() + 60 * 60_000,
        },
      },
    } as typeof state.deferredObjectiveSettings;
  }

  initDeviceDetailHandlers();
  openDeviceDetail(deviceId);
  await flushPromises();
  return { state, homey };
};

type MdSwitchLike = HTMLElement & { selected?: boolean; disabled?: boolean };
const row = () => document.querySelector('#device-detail-respect-external-off-row') as HTMLElement | null;
const toggle = () => document.querySelector('#device-detail-respect-external-off') as MdSwitchLike | null;
const powerLimitHint = () => document.querySelector('#device-detail-respect-external-off-power-limit-hint') as HTMLElement | null;
const smartTaskHint = () => document.querySelector('#device-detail-respect-external-off-smart-task-hint') as HTMLElement | null;

describe('device detail "Leave off until turned on again" gating', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    mockSiblings();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the row on a device PELS can switch', async () => {
    await openPanel({ device: buildBinaryDevice() });
    expect(row()?.hidden).toBe(false);
    expect(toggle()?.disabled).toBe(false);
  });

  it('shows the row on an EV charger, whose control capability is its own', async () => {
    await openPanel({
      device: buildBinaryDevice({
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        capabilities: ['evcharger_charging', 'evcharger_charging_state'],
      }),
    });
    expect(row()?.hidden).toBe(false);
  });

  it('hides the row on a device with no binary control capability', async () => {
    // Power metadata alone is not enough: detection rejects a non-binary device,
    // so the switch would persist a setting that never takes effect.
    await openPanel({
      device: buildBinaryDevice({
        deviceType: 'temperature',
        controlCapabilityId: undefined,
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        capabilities: ['target_temperature'],
      }),
    });
    expect(row()?.hidden).toBe(true);
  });

  it('keeps the row visible (escape hatch) when opted in but the shape no longer qualifies', async () => {
    // The only opt-OUT must stay reachable, or the device is held off with no way back.
    await openPanel({
      device: buildBinaryDevice({ controlCapabilityId: undefined, capabilities: [] }),
      optedIn: true,
    });
    expect(row()?.hidden).toBe(false);
    expect(toggle()?.selected).toBe(true);
  });

  it('reflects the persisted opt-in on the switch', async () => {
    await openPanel({ device: buildBinaryDevice(), optedIn: true });
    expect(toggle()?.selected).toBe(true);
  });

  it('disables the switch with the power-limit hint when Power-limit control is off', async () => {
    // The runtime requires control authority to detect the off action at all, so
    // the toggle would silently do nothing — surface why rather than lie.
    await openPanel({ device: buildBinaryDevice(), controllable: false });
    expect(row()?.hidden).toBe(false);
    expect(toggle()?.disabled).toBe(true);
    expect(powerLimitHint()?.hidden).toBe(false);
    expect(powerLimitHint()?.textContent).toContain('Power-limit control');
  });

  it('disables the switch on an unmanaged device without shouting about power limits', async () => {
    await openPanel({ device: buildBinaryDevice(), managed: false });
    expect(toggle()?.disabled).toBe(true);
    expect(powerLimitHint()?.hidden).toBe(true);
  });

  it('warns but does NOT block while a smart task is active', async () => {
    // An explicit off action is meant to beat a smart task; the hint only makes
    // the deadline consequence visible.
    await openPanel({ device: buildBinaryDevice(), activeSmartTask: true });
    expect(toggle()?.disabled).toBe(false);
    expect(smartTaskHint()?.hidden).toBe(false);
    expect(smartTaskHint()?.textContent).toContain('Smart task');
  });

  it('keeps an opted-in switch toggleable when the device stops qualifying', async () => {
    // Power metadata disappears, native wiring becomes required, Managed goes
    // off — the row stays visible, but a DISABLED switch would leave no way to
    // remove the opt-in, and PELS would silently honour it again if the device
    // later qualified.
    await openPanel({ device: buildBinaryDevice(), optedIn: true, managed: false });
    expect(row()?.hidden).toBe(false);
    expect(toggle()?.selected).toBe(true);
    expect(toggle()?.disabled).toBe(false);
  });

  it('hides both hints when nothing is in the way', async () => {
    await openPanel({ device: buildBinaryDevice() });
    expect(powerLimitHint()?.hidden).toBe(true);
    expect(smartTaskHint()?.hidden).toBe(true);
  });
});

describe('device detail "Leave off until turned on again" write', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    mockSiblings();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const flip = async (selected: boolean) => {
    const sw = toggle();
    if (!sw) throw new Error('switch missing');
    sw.selected = selected;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  };

  it('preserves other devices and drops stale false entries', async () => {
    const { homey } = await openPanel({
      device: buildBinaryDevice(),
      storedOptInMap: { 'other-1': true, 'stale-1': false },
    });
    await flip(true);
    expect(homey.__settingsStore.respect_external_off_devices).toEqual({
      'other-1': true,
      'heater-1': true,
    });
  });

  it('does not treat a malformed fresh read as authoritative', async () => {
    // The runtime rejects such a map wholesale and keeps its own last-good copy.
    // Building the write from it would persist a map derived from a corrupt
    // read; the UI's last-known map is the better evidence, so that is what the
    // change is applied to.
    const { state, homey } = await openPanel({
      device: buildBinaryDevice(),
      storedOptInMap: { 'other-1': true, 'junk-1': 'yes' },
    });
    state.respectExternalOffMap = { 'other-1': true };
    await flip(true);
    expect(homey.__settingsStore.respect_external_off_devices).toEqual({
      'other-1': true,
      'heater-1': true,
    });
  });

  it('enables the switch as soon as the user follows its own hint', async () => {
    // The hint sends the user to Power-limit control. If the panel does not
    // re-sync on that write, they turn it on and the switch they were sent to
    // is still disabled with the same hint showing.
    await openPanel({ device: buildBinaryDevice(), controllable: false });
    expect(toggle()?.disabled).toBe(true);
    expect(powerLimitHint()?.hidden).toBe(false);

    const powerLimit = document.querySelector('#device-detail-controllable') as MdSwitchLike;
    powerLimit.selected = true;
    powerLimit.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(toggle()?.disabled).toBe(false);
    expect(powerLimitHint()?.hidden).toBe(true);
  });

  it('opting out removes only this device, keeping the blob sparse', async () => {
    const { homey } = await openPanel({
      device: buildBinaryDevice(),
      optedIn: true,
      storedOptInMap: { 'other-1': true, 'heater-1': true },
    });
    await flip(false);
    expect(homey.__settingsStore.respect_external_off_devices).toEqual({ 'other-1': true });
  });
});
