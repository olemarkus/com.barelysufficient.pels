// The per-device "Charge on solar surplus" / "Match solar surplus" control gates
// on the same full candidacy the runtime `resolveSurplusTrackingPosture` does:
// the home's surplus pool must be reachable, and the device must be managed,
// manageable, non-temperature, and carry a usable step ladder. The switch is
// additionally disabled while the device has an active smart task (mirroring the
// plan-side `admittedDeviceIds` exclusion) or while Power-limit control is off
// (the posture would be inert at runtime).
//
// Also covers the thing that makes this control honest rather than just
// present: the label follows the device kind, because what happens differs.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
        <md-switch id="device-detail-managed"></md-switch>
        <md-switch id="device-detail-controllable"></md-switch>
        <md-switch id="device-detail-price-opt"></md-switch>
        <div class="md-switch-row" id="device-detail-surplus-track-row" hidden>
          <md-switch id="device-detail-surplus-track-opt"></md-switch>
          <span id="device-detail-surplus-track-label"></span>
          <small id="device-detail-surplus-track-hint"></small>
          <small id="device-detail-surplus-track-disabled-hint" hidden></small>
          <small id="device-detail-surplus-track-power-limit-hint" hidden></small>
        </div>
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
      </div>
    </div>
  `;
};

// A one-phase EV charger ladder: off, then the 6 A rung the preset actually
// carries (1380 W), then two above it.
const evLadder = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: '6a', planningPowerW: 1380, planningCurrentA: 6 },
    { id: '10a', planningPowerW: 2300, planningCurrentA: 10 },
    { id: '16a', planningPowerW: 3680, planningCurrentA: 16 },
  ],
};

const buildCharger = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'charger-1',
  name: 'Charger',
  targets: [],
  deviceClass: 'evcharger',
  powerCapable: true,
  controlModel: 'stepped_load',
  steppedLoadProfile: evLadder,
  capabilities: ['evcharger_charging'],
  ...overrides,
}) as TargetDeviceSnapshot;

const buildSteppedHeater = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Garage heater',
  targets: [],
  deviceClass: 'heater',
  powerCapable: true,
  controlModel: 'stepped_load',
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'low', planningPowerW: 800 },
      { id: 'high', planningPowerW: 2000 },
    ],
  },
  capabilities: [],
  ...overrides,
}) as TargetDeviceSnapshot;

const buildBinaryPump = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id: 'pump-1',
  name: 'Pool Pump',
  targets: [],
  deviceType: 'onoff',
  deviceClass: 'socket',
  powerCapable: true,
  binaryControl: { on: false },
  binaryControllable: true,
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
  surplusPoolReachable?: boolean;
  managed?: boolean;
  controllable?: boolean;
  surplusWilling?: boolean;
  activeSmartTask?: boolean;
  /** An unsaved control-mode draft, as the panel's own store would hold it. */
  storedTargetPowerConfig?: Record<string, unknown>;
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
    ? {
      [deviceId]: {
        enabled: false,
        cheapDelta: 0,
        expensiveDelta: 0,
        surplusWilling: true,
      },
    }
    : {};
  state.deviceTargetPowerConfigs = params.storedTargetPowerConfig
    ? { [deviceId]: params.storedTargetPowerConfig }
    : {};
  state.hasManagedSolarDevice = true;
  state.hasExhibitedExport = true;
  state.surplusPoolReachable = params.surplusPoolReachable ?? true;
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
          kind: 'ev_soc',
          enforcement: 'soft',
          targetPercent: 80,
          deadlineAtMs: Date.now() + 60 * 60_000,
        },
      },
    } as typeof state.deferredObjectiveSettings;
  } else {
    state.deferredObjectiveSettings = {
      version: 1,
      objectivesByDeviceId: {},
    } as typeof state.deferredObjectiveSettings;
  }

  initDeviceDetailHandlers();
  openDeviceDetail(deviceId);
  await flushPromises();
  return { state };
};

type MdSwitchLike = HTMLElement & { selected?: boolean; disabled?: boolean };
const trackRow = () => document.querySelector('#device-detail-surplus-track-row') as HTMLElement | null;
const trackSwitch = () => document.querySelector('#device-detail-surplus-track-opt') as MdSwitchLike | null;
const trackLabel = () => document.querySelector('#device-detail-surplus-track-label') as HTMLElement | null;
const powerLimitHint = () => document.querySelector('#device-detail-surplus-track-power-limit-hint') as HTMLElement | null;
const smartTaskHint = () => document.querySelector('#device-detail-surplus-track-disabled-hint') as HTMLElement | null;

describe('device detail solar-surplus tracking gating', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    mockSiblings();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the row on a managed stepped charger when the pool is reachable', async () => {
    await openPanel({ device: buildCharger() });
    expect(trackRow()?.hidden).toBe(false);
    expect(trackSwitch()?.disabled).toBe(false);
  });

  it('hides the row when no surplus can ever arrive', async () => {
    await openPanel({ device: buildCharger(), surplusPoolReachable: false });
    expect(trackRow()?.hidden).toBe(true);
  });

  it('keeps the row reachable for an opted-in device even with no reachable pool', async () => {
    // The escape hatch: an owner whose solar device disappeared must still be
    // able to turn the setting back off.
    await openPanel({
      device: buildCharger(),
      surplusPoolReachable: false,
      surplusWilling: true,
    });
    expect(trackRow()?.hidden).toBe(false);
  });

  it('hides the row on an unmanaged device', async () => {
    await openPanel({ device: buildCharger(), managed: false });
    expect(trackRow()?.hidden).toBe(true);
  });

  it('hides the row on a plain binary device — that is the dump load\'s modality', async () => {
    await openPanel({ device: buildBinaryPump() });
    expect(trackRow()?.hidden).toBe(true);
  });

  it('disables the switch while Power-limit control is off, and says why', async () => {
    await openPanel({ device: buildCharger(), controllable: false });
    expect(trackSwitch()?.disabled).toBe(true);
    expect(powerLimitHint()?.hidden).toBe(false);
  });

  it('disables the switch while a smart task governs the device, and says why', async () => {
    await openPanel({ device: buildCharger(), activeSmartTask: true });
    expect(trackSwitch()?.disabled).toBe(true);
    expect(smartTaskHint()?.hidden).toBe(false);
  });

  describe('copy', () => {
    it('labels a charger by what happens to it', async () => {
      await openPanel({ device: buildCharger() });
      expect(trackLabel()?.textContent).toBe('Charge on solar surplus');
    });

    it('labels a non-charger stepped device differently, because what happens differs', async () => {
      await openPanel({ device: buildSteppedHeater() });
      expect(trackLabel()?.textContent).toBe('Match solar surplus');
    });

  });
});
