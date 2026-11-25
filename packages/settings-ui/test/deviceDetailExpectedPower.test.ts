import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices';
import type { SteppedLoadDescriptorProbe } from '../../contracts/src/types';
import { DEVICE_EXPECTED_POWER_OVERRIDES } from '../../shared-domain/src/settings/settingsKeys';
import { createHomeyMock } from './helpers/homeyApiMock';
import { mockDeviceDetailCollaborators } from './helpers/deviceDetailCollaborators.ts';

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
        <md-switch id="device-detail-budget-exempt"></md-switch>
        <div id="device-detail-control-model-row">
          <select id="device-detail-control-model"></select>
        </div>
        <div id="device-detail-expected-power-row" hidden>
          <input id="device-detail-expected-power">
          <small id="device-detail-expected-power-source"></small>
        </div>
        <div id="device-detail-modes"></div>
        <div id="device-detail-delta-section"></div>
        <input id="device-detail-cheap-delta">
        <input id="device-detail-expensive-delta">
        <select id="device-detail-overshoot">
          <option value="turn_off">Turn off</option>
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
      </div>
    </div>
  `;
};

type TestDevice = SettingsUiDeviceSnapshot & SteppedLoadDescriptorProbe;

const buildDevice = (overrides: Partial<TestDevice> = {}): TestDevice => (withDescriptorIdentity<TestDevice>({
  available: true,
  id: 'heater-1',
  name: 'Hall Heater',
  targets: [],
  deviceType: 'onoff',
  powerCapable: true,
  expectedPowerKw: 1,
  expectedPowerSource: 'default',
  binaryControl: { on: true },
  capabilities: ['onoff'],
  ...overrides,
}));

const mockCollaborators = () => {
  mockDeviceDetailCollaborators();
};

const openDetailFor = async (device: TestDevice, persistedSettings: Record<string, unknown> = {}) => {
  mockCollaborators();
  const homeyModule = await import('../src/ui/homey.ts');
  const homey = createHomeyMock({ settings: persistedSettings });
  homeyModule.setHomeyClient(homey);
  const { initDeviceDetailHandlers, openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
  const { state } = await import('../src/ui/state.ts');

  state.latestDevices = [device];
  state.managedMap = { [device.id]: true };
  state.controllableMap = { [device.id]: true };
  state.budgetExemptMap = {};
  state.priceOptimizationSettings = {};
  state.deviceControlProfiles = {};
  state.deviceTargetPowerConfigs = {};
  state.deviceExpectedPowerOverrides = {};
  state.capacityPriorities = { Home: { [device.id]: 1 } };
  state.modeTargets = { Home: {} };
  state.activeMode = 'Home';
  state.editingMode = 'Home';

  initDeviceDetailHandlers();
  openDeviceDetail(device.id);
  await flushPromises();

  return { homey, state };
};

const field = () => document.querySelector('#device-detail-expected-power') as HTMLInputElement;
const row = () => document.querySelector('#device-detail-expected-power-row') as HTMLElement;
const sourceLine = () => document.querySelector('#device-detail-expected-power-source') as HTMLElement;

const typeAndCommit = async (value: string) => {
  field().value = value;
  field().dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
};

describe('device detail power when running', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prefills the resolved figure in watts and names the source answering now', async () => {
    await openDetailFor(buildDevice({ expectedPowerKw: 1.38, expectedPowerSource: 'default', measuredPowerKw: 0.8 }));

    expect(row().hidden).toBe(false);
    expect(field().value).toBe('1380');
    expect(sourceLine().hidden).toBe(false);
    expect(sourceLine().textContent).toBe('PELS is using a rough estimate of the running draw.');
  });

  it('hides Power when running while last-resort control remains configured', async () => {
    const { acceptDevicePowerSetup } = await import('../src/ui/devicePowerSetup.ts');
    const { renderExpectedPowerField } = await import('../src/ui/deviceDetail/expectedPower.ts');
    const relay = buildDevice();
    const configuration = {
      id: relay.id, name: relay.name, homeId: 'main', configured: true, sourceId: null, sourceReady: false, usedBy: null, sources: [],
      lastResortMaximumW: 4500, lastResortAvailable: true, defaultBinarySwitchAvailable: true,
    };
    acceptDevicePowerSetup({ devices: [configuration] });
    renderExpectedPowerField(relay);
    expect(row().hidden).toBe(true);

    acceptDevicePowerSetup({ devices: [{ ...configuration, lastResortAvailable: false }] });
    renderExpectedPowerField(relay);
    expect(row().hidden).toBe(true);

    acceptDevicePowerSetup({ devices: [{ ...configuration, lastResortMaximumW: undefined }] });
    renderExpectedPowerField(relay);
    expect(row().hidden).toBe(false);
    expect(field().value).toBe('1000');
  });

  it('names a measured source without inviting a correction', async () => {
    await openDetailFor(buildDevice({ expectedPowerKw: 2.1, expectedPowerSource: 'measured-peak' }));

    expect(field().value).toBe('2100');
    expect(sourceLine().textContent).toBe('PELS measured this while the device was running.');
  });

  it('writes the typed watts through as the manual kW figure', async () => {
    const { homey, state } = await openDetailFor(buildDevice());

    await typeAndCommit('2400');

    expect(homey.set).toHaveBeenCalledWith(
      DEVICE_EXPECTED_POWER_OVERRIDES,
      { 'heater-1': { kw: 2.4, ts: expect.any(Number), origin: 'settings' } },
      expect.any(Function),
    );
    expect(state.deviceExpectedPowerOverrides['heater-1']?.kw).toBe(2.4);
  });

  it('keeps other devices figures when writing one', async () => {
    const { homey } = await openDetailFor(buildDevice(), {
      [DEVICE_EXPECTED_POWER_OVERRIDES]: { 'other-1': { kw: 3, ts: 10 } },
    });

    await typeAndCommit('2400');

    expect(homey.set).toHaveBeenCalledWith(
      DEVICE_EXPECTED_POWER_OVERRIDES,
      {
        'other-1': { kw: 3, ts: 10 },
        'heater-1': { kw: 2.4, ts: expect.any(Number), origin: 'settings' },
      },
      expect.any(Function),
    );
  });

  it('saves the recommendation action\'s figure on the same record, keeping a Flow-set neighbour', async () => {
    const { homey } = await openDetailFor(buildDevice(), {
      [DEVICE_EXPECTED_POWER_OVERRIDES]: { 'other-1': { kw: 3, ts: 10, origin: 'flow' } },
    });
    const { resolveRecommendationTask } = await import('../src/ui/recommendationActions.ts');

    await resolveRecommendationTask({ kind: 'expected-power', deviceId: 'heater-1', kw: 4.5 }, null)?.run();
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      DEVICE_EXPECTED_POWER_OVERRIDES,
      {
        'other-1': { kw: 3, ts: 10, origin: 'flow' },
        'heater-1': { kw: 4.5, ts: expect.any(Number), origin: 'settings' },
      },
      expect.any(Function),
    );
  });

  it('clears back to automatic when the field is emptied', async () => {
    const { homey, state } = await openDetailFor(
      buildDevice({ expectedPowerKw: 2.4, expectedPowerSource: 'manual' }),
      { [DEVICE_EXPECTED_POWER_OVERRIDES]: { 'heater-1': { kw: 2.4, ts: 10 } } },
    );

    expect(field().value).toBe('2400');
    expect(sourceLine().textContent).toBe('This is your figure.');

    await typeAndCommit('   ');

    expect(homey.set).toHaveBeenCalledWith(
      DEVICE_EXPECTED_POWER_OVERRIDES,
      {},
      expect.any(Function),
    );
    expect(state.deviceExpectedPowerOverrides['heater-1']).toBeUndefined();
  });

  it('refuses a non-positive entry instead of silently clearing the figure', async () => {
    const { homey } = await openDetailFor(
      buildDevice({ expectedPowerKw: 2.4, expectedPowerSource: 'manual' }),
      { [DEVICE_EXPECTED_POWER_OVERRIDES]: { 'heater-1': { kw: 2.4, ts: 10 } } },
    );

    await typeAndCommit('0');

    expect(homey.set).not.toHaveBeenCalledWith(
      DEVICE_EXPECTED_POWER_OVERRIDES,
      expect.anything(),
      expect.any(Function),
    );
    // Re-rendered from the device, so the owner sees the figure still standing.
    expect(field().value).toBe('2400');
  });

  it('hides the field for a stepped load, which is sized per configured step', async () => {
    await openDetailFor(buildDevice({
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        steps: [{ id: 'step_1', planningPowerW: 1000 }],
      },
    }));

    expect(row().hidden).toBe(true);
  });

  it('shows the field for a native candidate whose stepped activation is still off', async () => {
    // A suggestion is not a control model. With activation off the device is
    // binary-controlled, `setExpectedOverride` takes its figure, and hiding the
    // field would strand the owner with no way to correct the estimate.
    await openDetailFor(buildDevice({
      controlAdapter: { kind: 'capability_adapter', activationRequired: true, activationEnabled: false },
      suggestedSteppedLoadProfile: {
        steps: [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 2000 }],
      },
    }));

    expect(row().hidden).toBe(false);
  });

  it('hides the field again once that native stepped activation is enabled', async () => {
    await openDetailFor(buildDevice({
      controlAdapter: {
        kind: 'capability_adapter',
        activationAvailable: true,
        activationRequired: true,
        activationEnabled: true,
      },
      suggestedSteppedLoadProfile: {
        steps: [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 2000 }],
      },
    }));

    expect(row().hidden).toBe(true);
  });
});
