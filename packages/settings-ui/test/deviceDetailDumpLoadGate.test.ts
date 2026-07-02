// The per-device "Run on solar surplus" (dump-load) control gates on the FULL
// candidacy: home has a tracked solar device, the device is a managed,
// manageable (canManageDevice — fixed for this section from day one), plain
// binary device — not temperature, not stepped, not EV. The switch itself is
// additionally disabled while the device has an active smart task
// (defense-in-depth mirror of the plan-side admittedDeviceIds exclusion).
// Also covers the blob round-trip: enabling writes the full valid entry
// {enabled:false, cheapDelta:0, expensiveDelta:0, surplusWilling:true}.
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
        <div class="md-switch-row" id="device-detail-dump-load-row" hidden>
          <md-switch id="device-detail-dump-load-opt"></md-switch>
          <small class="field__hint" id="device-detail-dump-load-disabled-hint" hidden>Unavailable while this device has an active smart task — the task's schedule decides when it runs.</small>
          <small class="field__hint" id="device-detail-dump-load-power-limit-hint" hidden>Turn on Power-limit control above first — PELS needs it to switch this device on and off.</small>
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

// A plain binary (on/off) device — no temperature target, no stepped control,
// not an EV. `powerCapable` makes it manageable.
const buildBinaryDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'pump-1',
  name: 'Pool Pump',
  targets: [],
  deviceType: 'onoff',
  deviceClass: 'socket',
  powerCapable: true,
  binaryControl: { on: false },
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
  vi.doMock('../src/ui/toast.ts', () => ({ showToastError: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
};

type OpenPanelParams = {
  hasManagedSolarDevice: boolean;
  hasExhibitedExport?: boolean;
  device: TargetDeviceSnapshot;
  managed?: boolean;
  controllable?: boolean;
  surplusWilling?: boolean;
  activeSmartTask?: boolean;
};

const openPanel = async (params: OpenPanelParams) => {
  const homeyModule = await import('../src/ui/homey.ts');
  homeyModule.setHomeyClient(createHomeyMock());
  const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
  const { state } = await import('../src/ui/state.ts');

  const deviceId = params.device.id;
  state.latestDevices = [params.device];
  state.managedMap = { [deviceId]: params.managed ?? true };
  state.controllableMap = { [deviceId]: params.controllable ?? true };
  state.budgetExemptMap = {};
  state.priceOptimizationSettings = params.surplusWilling
    ? { [deviceId]: { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true } }
    : {};
  state.hasManagedSolarDevice = params.hasManagedSolarDevice;
  state.hasExhibitedExport = params.hasExhibitedExport ?? false;
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
  return { state };
};

type MdSwitchLike = HTMLElement & { selected?: boolean; disabled?: boolean };
const dumpLoadRow = () => document.querySelector('#device-detail-dump-load-row') as HTMLElement | null;
const dumpLoadSwitch = () => document.querySelector('#device-detail-dump-load-opt') as MdSwitchLike | null;
const dumpLoadDisabledHint = () => document.querySelector('#device-detail-dump-load-disabled-hint') as HTMLElement | null;
const dumpLoadPowerLimitHint = () => document.querySelector('#device-detail-dump-load-power-limit-hint') as HTMLElement | null;

describe('device detail "Run on solar surplus" (dump-load) gating', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    mockSiblings();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('hides the row when the home has no tracked solar device', async () => {
    await openPanel({ hasManagedSolarDevice: false, device: buildBinaryDevice() });
    expect(dumpLoadRow()?.hidden).toBe(true);
  });

  it('shows the row on a managed plain binary device when solar is present', async () => {
    await openPanel({ hasManagedSolarDevice: true, device: buildBinaryDevice() });
    expect(dumpLoadRow()?.hidden).toBe(false);
    expect(dumpLoadSwitch()?.disabled).toBe(false);
  });

  it('shows the row for a meter-only PV home (exhibited export, no solar device)', async () => {
    await openPanel({ hasManagedSolarDevice: false, hasExhibitedExport: true, device: buildBinaryDevice() });
    expect(dumpLoadRow()?.hidden).toBe(false);
    expect(dumpLoadSwitch()?.disabled).toBe(false);
  });

  it('reflects the persisted opt-in on the switch', async () => {
    await openPanel({ hasManagedSolarDevice: true, device: buildBinaryDevice(), surplusWilling: true });
    expect(dumpLoadSwitch()?.selected).toBe(true);
  });

  it('hides the row on a temperature device (that modality gets the setpoint lift instead)', async () => {
    await openPanel({
      hasManagedSolarDevice: true,
      device: buildBinaryDevice({
        deviceType: 'temperature',
        targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
        capabilities: ['target_temperature', 'onoff'],
      }),
    });
    expect(dumpLoadRow()?.hidden).toBe(true);
  });

  it('hides the row on an EV charger', async () => {
    await openPanel({
      hasManagedSolarDevice: true,
      device: buildBinaryDevice({
        deviceClass: 'evcharger',
        controlCapabilityId: 'evcharger_charging',
        capabilities: ['evcharger_charging', 'evcharger_charging_state'],
      }),
    });
    expect(dumpLoadRow()?.hidden).toBe(true);
  });

  it('hides the row on a stepped/continuous-controlled device', async () => {
    await openPanel({
      hasManagedSolarDevice: true,
      device: buildBinaryDevice({
        targetPowerConfig: { enabled: true },
      } as Partial<TargetDeviceSnapshot>),
    });
    expect(dumpLoadRow()?.hidden).toBe(true);
  });

  it('hides the row on a device without a binary control capability', async () => {
    await openPanel({
      hasManagedSolarDevice: true,
      device: buildBinaryDevice({ controlCapabilityId: undefined, capabilities: [] }),
    });
    expect(dumpLoadRow()?.hidden).toBe(true);
  });

  it('hides the row on an unmanaged device', async () => {
    await openPanel({ hasManagedSolarDevice: true, device: buildBinaryDevice(), managed: false });
    expect(dumpLoadRow()?.hidden).toBe(true);
  });

  it('keeps the row visible (escape hatch) when opted in but the solar device has disappeared', async () => {
    // The only opt-OUT must stay reachable even after the home's solar device
    // goes away — otherwise the device is held off forever with no way back.
    await openPanel({ hasManagedSolarDevice: false, device: buildBinaryDevice(), surplusWilling: true });
    expect(dumpLoadRow()?.hidden).toBe(false);
    expect(dumpLoadSwitch()?.selected).toBe(true);
    expect(dumpLoadSwitch()?.disabled).toBe(false);
  });

  it('still hides the row for a non-opted-in device when the solar device disappears', async () => {
    await openPanel({ hasManagedSolarDevice: false, device: buildBinaryDevice() });
    expect(dumpLoadRow()?.hidden).toBe(true);
  });

  it('hides the row when the device still needs built-in control activation (canManageDevice gate)', async () => {
    await openPanel({
      hasManagedSolarDevice: true,
      device: buildBinaryDevice({
        controlAdapter: {
          kind: 'capability_adapter',
          activationRequired: true,
          activationEnabled: false,
        },
      } as Partial<TargetDeviceSnapshot>),
    });
    expect(dumpLoadRow()?.hidden).toBe(true);
  });

  it('disables the switch with a visible "why" hint while the device has an active smart task', async () => {
    await openPanel({ hasManagedSolarDevice: true, device: buildBinaryDevice(), activeSmartTask: true });
    expect(dumpLoadRow()?.hidden).toBe(false);
    expect(dumpLoadSwitch()?.disabled).toBe(true);
    // The disabled state has an explanation (never reads "on but broken").
    expect(dumpLoadDisabledHint()?.hidden).toBe(false);
    expect(dumpLoadDisabledHint()?.textContent).toContain('active smart task');
  });

  it('hides the disabled hint when the switch is enabled', async () => {
    await openPanel({ hasManagedSolarDevice: true, device: buildBinaryDevice() });
    expect(dumpLoadSwitch()?.disabled).toBe(false);
    expect(dumpLoadDisabledHint()?.hidden).toBe(true);
    expect(dumpLoadPowerLimitHint()?.hidden).toBe(true);
  });

  it('disables the switch with the power-limit hint when Power-limit control is off', async () => {
    // Runtime gates surplusOnly on isCapacityControlEnabled (managed AND controllable);
    // with power-limiting off the toggle would silently do nothing, so surface why.
    await openPanel({ hasManagedSolarDevice: true, device: buildBinaryDevice(), controllable: false });
    expect(dumpLoadRow()?.hidden).toBe(false);
    expect(dumpLoadSwitch()?.disabled).toBe(true);
    expect(dumpLoadPowerLimitHint()?.hidden).toBe(false);
    expect(dumpLoadPowerLimitHint()?.textContent).toContain('Power-limit control');
    expect(dumpLoadDisabledHint()?.hidden).toBe(true);
  });

  it('shows the power-limit hint (not the smart-task hint) when both blockers apply', async () => {
    await openPanel({
      hasManagedSolarDevice: true,
      device: buildBinaryDevice(),
      controllable: false,
      activeSmartTask: true,
    });
    expect(dumpLoadSwitch()?.disabled).toBe(true);
    expect(dumpLoadPowerLimitHint()?.hidden).toBe(false);
    expect(dumpLoadDisabledHint()?.hidden).toBe(true);
  });

  it('reflects the opted-in state while disabled by power-limit-off (honest, not hidden)', async () => {
    await openPanel({
      hasManagedSolarDevice: true,
      device: buildBinaryDevice(),
      controllable: false,
      surplusWilling: true,
    });
    expect(dumpLoadRow()?.hidden).toBe(false);
    expect(dumpLoadSwitch()?.selected).toBe(true);
    expect(dumpLoadSwitch()?.disabled).toBe(true);
    expect(dumpLoadPowerLimitHint()?.hidden).toBe(false);
  });
});

describe('device detail "Run on solar surplus" blob round-trip', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    mockSiblings();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const toggle = async (selected: boolean) => {
    const sw = dumpLoadSwitch();
    if (!sw) throw new Error('dump-load switch missing');
    sw.selected = selected;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
  };

  it('enabling writes the FULL valid entry with zero deltas and price-response off', async () => {
    const { state } = await openPanel({ hasManagedSolarDevice: true, device: buildBinaryDevice() });
    const { savePriceOptimizationSettings } = await import('../src/ui/priceOptimization.ts');
    await toggle(true);
    expect(state.priceOptimizationSettings['pump-1']).toEqual({
      enabled: false,
      cheapDelta: 0,
      expensiveDelta: 0,
      surplusWilling: true,
    });
    expect(savePriceOptimizationSettings).toHaveBeenCalled();
  });

  it('disabling flips only surplusWilling and preserves the rest of an existing entry', async () => {
    const { state } = await openPanel({
      hasManagedSolarDevice: true,
      device: buildBinaryDevice(),
      surplusWilling: true,
    });
    await toggle(false);
    expect(state.priceOptimizationSettings['pump-1']).toEqual({
      enabled: false,
      cheapDelta: 0,
      expensiveDelta: 0,
      surplusWilling: false,
    });
  });

  it('lets the user opt OUT via the escape hatch when the solar device has disappeared', async () => {
    // Escape hatch: opted in, but the home no longer has a solar device. The
    // opt-out must still save (the save handler gates on device SHAPE, not the
    // solar-offer gate) — otherwise the device would be held off forever.
    const { state } = await openPanel({
      hasManagedSolarDevice: false,
      device: buildBinaryDevice(),
      surplusWilling: true,
    });
    await toggle(false);
    expect(state.priceOptimizationSettings['pump-1']?.surplusWilling).toBe(false);
  });

  it('rolls the optimistic write back when the save fails', async () => {
    const { state } = await openPanel({ hasManagedSolarDevice: true, device: buildBinaryDevice() });
    const { savePriceOptimizationSettings } = await import('../src/ui/priceOptimization.ts');
    (savePriceOptimizationSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await toggle(true);
    expect(state.priceOptimizationSettings['pump-1']).toBeUndefined();
    expect(dumpLoadSwitch()?.selected).toBe(false);
  });
});
