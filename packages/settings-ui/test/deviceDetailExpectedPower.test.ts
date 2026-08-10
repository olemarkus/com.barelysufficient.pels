import type { SteppedLoadDescriptorProbe, TargetDeviceSnapshot } from '../../contracts/src/types';
import { DEVICE_EXPECTED_POWER_OVERRIDES } from '../../contracts/src/settingsKeys';
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

type TestDevice = TargetDeviceSnapshot & SteppedLoadDescriptorProbe;

const buildDevice = (overrides: Partial<TestDevice> = {}): TestDevice => ({
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
});

const mockCollaborators = () => {
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
  vi.doMock('../src/ui/logging.ts', () => ({
    logSettingsError: vi.fn().mockResolvedValue(undefined),
  }));
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
    await openDetailFor(buildDevice({ expectedPowerKw: 1.38, expectedPowerSource: 'default' }));

    expect(row().hidden).toBe(false);
    expect(field().value).toBe('1380');
    // The `default` rung is the reported bug's signature: it must read as an
    // invitation to correct the figure, not as a settled fact.
    expect(sourceLine().hidden).toBe(false);
    expect(sourceLine().textContent).toContain('no reading for this device yet');
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
      { 'heater-1': { kw: 2.4, ts: expect.any(Number) } },
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
        'heater-1': { kw: 2.4, ts: expect.any(Number) },
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
        model: 'stepped_load',
        steps: [{ id: 'step_1', planningPowerW: 1000 }],
      },
    }));

    expect(row().hidden).toBe(true);
  });
});
