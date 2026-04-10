import type { TargetDeviceSnapshot } from '../../contracts/src/types';
import type { Mock } from 'vitest';

type Harness = {
  managedCheckbox: HTMLInputElement;
  controllableCheckbox: HTMLInputElement;
  priceOptCheckbox: HTMLInputElement;
  debouncedSetSetting: Mock;
  logSettingsWarn: Mock;
  savePriceOptimizationSettings: Mock;
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
  currentOn: true,
  ...overrides,
});

const setupHarness = async (options: {
  initialLoadComplete: boolean;
  isManaged?: boolean;
  deviceOverrides?: Partial<TargetDeviceSnapshot>;
}): Promise<Harness> => {
  setupDom();
  vi.resetModules();

  const debouncedSetSetting = vi.fn().mockResolvedValue(undefined);
  const logSettingsWarn = vi.fn().mockResolvedValue(undefined);
  const savePriceOptimizationSettings = vi.fn().mockResolvedValue(undefined);

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
  vi.doMock('../src/ui/priceOptimization.ts', () => ({
    renderPriceOptimization: vi.fn(),
    savePriceOptimizationSettings,
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
    vi.resetModules();
    vi.clearAllMocks();
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

    expect(managedCheckbox.checked).toBe(true);
    expect(managedCheckbox.disabled).toBe(false);
    expect(controllableCheckbox.disabled).toBe(true);
    expect(priceOptCheckbox.disabled).toBe(false);
  });
});
