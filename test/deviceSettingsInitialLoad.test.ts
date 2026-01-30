import type { TargetDeviceSnapshot } from '../lib/utils/types';

type Harness = {
  managedCheckbox: HTMLInputElement;
  controllableCheckbox: HTMLInputElement;
  priceOptCheckbox: HTMLInputElement;
  debouncedSetSetting: jest.Mock;
  logSettingsWarn: jest.Mock;
  savePriceOptimizationSettings: jest.Mock;
};

const setupDom = () => {
  document.body.innerHTML = `
    <div id="device-list"></div>
    <div id="empty-state"></div>
    <button id="refresh-button"></button>
  `;
};

const buildDevice = (overrides?: Partial<TargetDeviceSnapshot>): TargetDeviceSnapshot => ({
  id: 'device-1',
  name: 'Test Device',
  targets: [],
  deviceType: 'temperature',
  ...overrides,
});

const setupHarness = async (options: {
  initialLoadComplete: boolean;
  isManaged?: boolean;
  deviceOverrides?: Partial<TargetDeviceSnapshot>;
}): Promise<Harness> => {
  setupDom();
  jest.resetModules();

  const debouncedSetSetting = jest.fn().mockResolvedValue(undefined);
  const logSettingsWarn = jest.fn().mockResolvedValue(undefined);
  const savePriceOptimizationSettings = jest.fn().mockResolvedValue(undefined);

  jest.doMock('../settings/src/ui/utils', () => ({
    debouncedSetSetting,
  }));
  jest.doMock('../settings/src/ui/logging', () => ({
    logSettingsWarn,
    logSettingsError: jest.fn().mockResolvedValue(undefined),
  }));
  jest.doMock('../settings/src/ui/modes', () => ({
    renderPriorities: jest.fn(),
  }));
  jest.doMock('../settings/src/ui/priceOptimization', () => ({
    renderPriceOptimization: jest.fn(),
    savePriceOptimizationSettings,
  }));
  jest.doMock('../settings/src/ui/plan', () => ({
    refreshPlan: jest.fn(),
  }));
  jest.doMock('../settings/src/ui/toast', () => ({
    showToast: jest.fn(),
    showToastError: jest.fn(),
  }));

  let renderDevices!: typeof import('../settings/src/ui/devices').renderDevices;
  let state!: typeof import('../settings/src/ui/state').state;

  jest.isolateModules(() => {
    ({ renderDevices } = require('../settings/src/ui/devices') as typeof import('../settings/src/ui/devices'));
    ({ state } = require('../settings/src/ui/state') as typeof import('../settings/src/ui/state'));
  });

  const device = buildDevice(options.deviceOverrides);
  state.initialLoadComplete = options.initialLoadComplete;
  state.latestDevices = [device];
  state.managedMap = options.isManaged ? { [device.id]: true } : {};
  state.controllableMap = {};
  state.priceOptimizationSettings = {};

  renderDevices([device]);

  const deviceList = document.getElementById('device-list');
  const checkboxes = deviceList?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [];
  const managedCheckbox = checkboxes[0];
  const controllableCheckbox = checkboxes[1];
  const priceOptCheckbox = checkboxes[2];
  if (!managedCheckbox) {
    throw new Error('Managed checkbox not found in device list.');
  }
  if (!controllableCheckbox || !priceOptCheckbox) {
    throw new Error('Expected controllable and price optimization checkboxes.');
  }

  return {
    managedCheckbox,
    controllableCheckbox,
    priceOptCheckbox,
    debouncedSetSetting,
    logSettingsWarn,
    savePriceOptimizationSettings,
  };
};

describe('device settings initial load guard', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('blocks managed toggle before initial load completes', async () => {
    const {
      managedCheckbox,
      debouncedSetSetting,
      logSettingsWarn,
    } = await setupHarness({ initialLoadComplete: false, isManaged: true });

    managedCheckbox.checked = true;
    managedCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(debouncedSetSetting).not.toHaveBeenCalled();
    expect(logSettingsWarn).toHaveBeenCalledTimes(1);
  });

  it('disables toggles while initial load is pending', async () => {
    const {
      managedCheckbox,
      controllableCheckbox,
      priceOptCheckbox,
    } = await setupHarness({ initialLoadComplete: false, isManaged: true });

    expect(managedCheckbox.disabled).toBe(true);
    expect(controllableCheckbox.disabled).toBe(true);
    expect(priceOptCheckbox.disabled).toBe(true);
  });

  it('allows managed toggle after initial load completes', async () => {
    const { managedCheckbox, debouncedSetSetting, logSettingsWarn } = await setupHarness({
      initialLoadComplete: true,
      deviceOverrides: { powerCapable: true },
    });

    managedCheckbox.checked = false;
    managedCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(logSettingsWarn).not.toHaveBeenCalled();
    expect(debouncedSetSetting).toHaveBeenCalledTimes(1);
    const [[key, getValue]] = debouncedSetSetting.mock.calls;
    expect(key).toBe('managed_devices');
    expect(typeof getValue).toBe('function');
    expect(getValue()).toEqual({ 'device-1': false });
  });

  it('blocks controllable and price toggles before initial load completes', async () => {
    const {
      controllableCheckbox,
      priceOptCheckbox,
      debouncedSetSetting,
      logSettingsWarn,
      savePriceOptimizationSettings,
    } = await setupHarness({ initialLoadComplete: false, isManaged: true });

    controllableCheckbox.checked = true;
    controllableCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    priceOptCheckbox.checked = true;
    priceOptCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(debouncedSetSetting).not.toHaveBeenCalled();
    expect(savePriceOptimizationSettings).not.toHaveBeenCalled();
    expect(logSettingsWarn).toHaveBeenCalledTimes(2);
  });

  it('enables controllable and price toggles after initial load completes', async () => {
    const {
      controllableCheckbox,
      priceOptCheckbox,
      debouncedSetSetting,
      savePriceOptimizationSettings,
    } = await setupHarness({ initialLoadComplete: true, isManaged: true, deviceOverrides: { powerCapable: true } });

    expect(controllableCheckbox.disabled).toBe(false);
    expect(priceOptCheckbox.disabled).toBe(false);

    controllableCheckbox.checked = false;
    controllableCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    priceOptCheckbox.checked = true;
    priceOptCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(debouncedSetSetting).toHaveBeenCalledTimes(1);
    expect(debouncedSetSetting).toHaveBeenCalledWith('controllable_devices', expect.any(Function));
    expect(savePriceOptimizationSettings).toHaveBeenCalledTimes(1);
  });

  it('disables feature toggles for devices without power capability', async () => {
    const {
      managedCheckbox,
      controllableCheckbox,
      priceOptCheckbox,
    } = await setupHarness({
      initialLoadComplete: true,
      isManaged: true,
      deviceOverrides: { powerCapable: false },
    });

    expect(managedCheckbox.checked).toBe(false);
    expect(managedCheckbox.disabled).toBe(true);
    expect(controllableCheckbox.disabled).toBe(true);
    expect(priceOptCheckbox.disabled).toBe(true);
  });
});
