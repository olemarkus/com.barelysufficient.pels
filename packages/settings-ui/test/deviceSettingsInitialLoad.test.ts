import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices';
import type { Mock } from 'vitest';

type Harness = {
  managedCheckbox: HTMLElement;
  controllableCheckbox: HTMLElement;
  priceOptCheckbox: HTMLElement;
  debouncedSetSetting: Mock;
  logSettingsWarn: Mock;
  saveDevicePriceEnabled: Mock;
};

const setupDom = () => {
  document.body.innerHTML = `
    <div id="device-card-list"></div>
    <div id="empty-state"></div>
    <md-outlined-button id="refresh-button"></md-outlined-button>
  `;
};

const buildDevice = (overrides?: Partial<SettingsUiDeviceSnapshot>): SettingsUiDeviceSnapshot => (withDescriptorIdentity<SettingsUiDeviceSnapshot>({ available: true, expectedPowerKw: 1, expectedPowerSource: 'default',
  id: 'device-1',
  name: 'Test Device',
  targets: [],
  deviceType: 'temperature',
  binaryControl: { on: true },
  ...overrides,
}));

const setupHarness = async (options: {
  initialLoadComplete: boolean;
  isManaged?: boolean;
  deviceOverrides?: Partial<SettingsUiDeviceSnapshot>;
}): Promise<Harness> => {
  setupDom();
  vi.resetModules();

  const debouncedSetSetting = vi.fn().mockResolvedValue(undefined);
  const logSettingsWarn = vi.fn().mockResolvedValue(undefined);
  const saveDevicePriceEnabled = vi.fn().mockResolvedValue(undefined);

  vi.doMock('../src/ui/utils.ts', () => ({
    debouncedSetSetting,
  }));
  vi.doMock('../src/ui/logging.ts', () => ({
    logSettingsWarn,
    logSettingsError: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/ui/modes.ts', () => ({
    renderPriorities: vi.fn(),
  }));
  vi.doMock('../src/ui/priceConfig.ts', () => ({
    renderPriceConfigDevices: vi.fn(),
  }));
  vi.doMock('../src/ui/priceOptimization.ts', () => ({
    saveDevicePriceEnabled,
  }));
  vi.doMock('../src/ui/plan.ts', () => ({
    refreshPlan: vi.fn(),
  }));
  vi.doMock('../src/ui/toast.ts', () => ({
    showToast: vi.fn(),
    showToastError: vi.fn(),
  }));

  const { renderDevices } = await import('../src/ui/devices.ts');
  const { state } = await import('../src/ui/state.ts');

  const device = buildDevice(options.deviceOverrides);
  state.initialLoadComplete = options.initialLoadComplete;
  state.latestDevices = [device];
  state.managedMap = options.isManaged ? { [device.id]: true } : {};
  state.controllableMap = {};
  state.priceOptimizationSettings = {};

  renderDevices([device]);

  const deviceList = document.getElementById('device-card-list');
  const checkboxes = deviceList?.querySelectorAll<HTMLElement>('.pels-icon-toggle') ?? [];
  const managedCheckbox = checkboxes[0];
  const controllableCheckbox = checkboxes[1];
  const priceOptCheckbox = checkboxes[2];
  if (!managedCheckbox) {
    throw new Error('Managed toggle not found in device list.');
  }
  if (!controllableCheckbox || !priceOptCheckbox) {
    throw new Error('Expected controllable and price optimization toggles.');
  }

  return {
    managedCheckbox,
    controllableCheckbox,
    priceOptCheckbox,
    debouncedSetSetting,
    logSettingsWarn,
    saveDevicePriceEnabled,
  };
};

describe('device settings initial load guard', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('blocks managed toggle before initial load completes', async () => {
    const {
      managedCheckbox,
      debouncedSetSetting,
    } = await setupHarness({ initialLoadComplete: false, isManaged: true });

    // While the initial load is pending, the toggle is rendered with aria-disabled
    // so clicks are ignored before reaching the change handler.
    expect(managedCheckbox.getAttribute('aria-disabled')).toBe('true');
    managedCheckbox.click();
    await Promise.resolve();

    expect(debouncedSetSetting).not.toHaveBeenCalled();
  });

  it('disables toggles while initial load is pending', async () => {
    const {
      managedCheckbox,
      controllableCheckbox,
      priceOptCheckbox,
    } = await setupHarness({ initialLoadComplete: false, isManaged: true });

    expect(managedCheckbox.getAttribute('aria-disabled')).toBe('true');
    expect(controllableCheckbox.getAttribute('aria-disabled')).toBe('true');
    expect(priceOptCheckbox.getAttribute('aria-disabled')).toBe('true');
  });

  it('allows managed toggle after initial load completes', async () => {
    const { managedCheckbox, debouncedSetSetting, logSettingsWarn } = await setupHarness({
      initialLoadComplete: true,
      deviceOverrides: { powerCapable: true },
    });

    // Initial state is unmanaged (not in managedMap), click will set to managed=true
    managedCheckbox.click();
    await Promise.resolve();

    expect(logSettingsWarn).not.toHaveBeenCalled();
    expect(debouncedSetSetting).toHaveBeenCalledTimes(1);
    const [[key, getValue]] = debouncedSetSetting.mock.calls;
    expect(key).toBe('managed_devices');
    expect(typeof getValue).toBe('function');
    expect(getValue()).toEqual({ 'device-1': true });
  });

  it.each([false, true])('allows management before binary power setup, with Managed %s', async (isManaged) => {
    const { managedCheckbox, controllableCheckbox, priceOptCheckbox, debouncedSetSetting } = await setupHarness({
      initialLoadComplete: true,
      isManaged,
      deviceOverrides: {
        deviceClass: 'socket', deviceType: 'onoff', binaryControllable: true,
        capabilities: ['onoff'], powerCapable: false,
      },
    });

    expect(managedCheckbox.getAttribute('aria-disabled')).not.toBe('true');
    expect(managedCheckbox.getAttribute('aria-checked')).toBe(String(isManaged));
    expect(controllableCheckbox.getAttribute('aria-disabled')).toBe('true');
    expect(priceOptCheckbox.getAttribute('aria-disabled')).toBe('true');
    const warning = document.querySelector<HTMLElement>('.pels-device-card__power-warning');
    expect(warning?.getAttribute('aria-label')).toContain('Power use needs setup');
    expect(warning?.dataset.tooltip).toContain('Advanced settings in Homey');
    expect(warning?.dataset.tooltipGuide).toContain('#device-energy-settings');
    expect(document.querySelector('.pels-device-card__reasons')).toBeNull();
    if (!isManaged) {
      managedCheckbox.click();
      await Promise.resolve();
      const managedWrite = debouncedSetSetting.mock.calls.find(([key]) => key === 'managed_devices');
      expect(managedWrite?.[1]()).toEqual({ 'device-1': true });
      expect(debouncedSetSetting.mock.calls.some(([key]) => key === 'controllable_devices')).toBe(false);
    }
  });

  it('does not show the setup warning once Homey has power information', async () => {
    await setupHarness({ initialLoadComplete: true, deviceOverrides: {
      deviceClass: 'socket', deviceType: 'onoff', binaryControllable: true,
      capabilities: ['onoff'], powerCapable: true,
    } });
    expect(document.querySelector('.pels-device-card__power-warning')).toBeNull();
  });

  it('blocks controllable and price toggles before initial load completes', async () => {
    const {
      controllableCheckbox,
      priceOptCheckbox,
      debouncedSetSetting,
      saveDevicePriceEnabled,
    } = await setupHarness({ initialLoadComplete: false, isManaged: true });

    expect(controllableCheckbox.getAttribute('aria-disabled')).toBe('true');
    expect(priceOptCheckbox.getAttribute('aria-disabled')).toBe('true');
    controllableCheckbox.click();
    priceOptCheckbox.click();
    await Promise.resolve();

    expect(debouncedSetSetting).not.toHaveBeenCalled();
    expect(saveDevicePriceEnabled).not.toHaveBeenCalled();
  });

  it('enables controllable and price toggles after initial load completes', async () => {
    const {
      controllableCheckbox,
      priceOptCheckbox,
      debouncedSetSetting,
      saveDevicePriceEnabled,
    } = await setupHarness({ initialLoadComplete: true, isManaged: true, deviceOverrides: { powerCapable: true } });

    expect(controllableCheckbox.getAttribute('aria-disabled')).not.toBe('true');
    expect(priceOptCheckbox.getAttribute('aria-disabled')).not.toBe('true');

    controllableCheckbox.click();
    priceOptCheckbox.click();
    await Promise.resolve();

    expect(debouncedSetSetting).toHaveBeenCalledTimes(1);
    expect(debouncedSetSetting).toHaveBeenCalledWith('controllable_devices', expect.any(Function));
    expect(saveDevicePriceEnabled).toHaveBeenCalledTimes(1);
  });

  it('allows managed and price toggles, but keeps capacity toggle disabled, for temperature devices without power capability', async () => {
    const {
      managedCheckbox,
      controllableCheckbox,
      priceOptCheckbox,
    } = await setupHarness({
      initialLoadComplete: true,
      isManaged: true,
      deviceOverrides: { powerCapable: false },
    });

    expect(managedCheckbox.getAttribute('aria-checked')).toBe('true');
    expect(managedCheckbox.getAttribute('aria-disabled')).not.toBe('true');
    expect(controllableCheckbox.getAttribute('aria-disabled')).toBe('true');
    expect(priceOptCheckbox.getAttribute('aria-disabled')).not.toBe('true');
  });
});
