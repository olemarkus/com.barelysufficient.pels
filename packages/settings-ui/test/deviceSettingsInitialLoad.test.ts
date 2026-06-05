import type { TargetDeviceSnapshot } from '../../contracts/src/types';
import type { Mock } from 'vitest';

type Harness = {
  managedCheckbox: HTMLElement;
  controllableCheckbox: HTMLElement;
  priceOptCheckbox: HTMLElement;
  debouncedSetSetting: Mock;
  logSettingsWarn: Mock;
  savePriceOptimizationSettings: Mock;
};

const setupDom = () => {
  document.body.innerHTML = `
    <div id="device-card-list"></div>
    <div id="empty-state"></div>
    <md-outlined-button id="refresh-button"></md-outlined-button>
  `;
};

const buildDevice = (overrides?: Partial<TargetDeviceSnapshot>): TargetDeviceSnapshot => ({
  id: 'device-1',
  name: 'Test Device',
  targets: [],
  deviceType: 'temperature',
  binaryControl: { on: true },
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

  it('blocks controllable and price toggles before initial load completes', async () => {
    const {
      controllableCheckbox,
      priceOptCheckbox,
      debouncedSetSetting,
      savePriceOptimizationSettings,
    } = await setupHarness({ initialLoadComplete: false, isManaged: true });

    expect(controllableCheckbox.getAttribute('aria-disabled')).toBe('true');
    expect(priceOptCheckbox.getAttribute('aria-disabled')).toBe('true');
    controllableCheckbox.click();
    priceOptCheckbox.click();
    await Promise.resolve();

    expect(debouncedSetSetting).not.toHaveBeenCalled();
    expect(savePriceOptimizationSettings).not.toHaveBeenCalled();
  });

  it('enables controllable and price toggles after initial load completes', async () => {
    const {
      controllableCheckbox,
      priceOptCheckbox,
      debouncedSetSetting,
      savePriceOptimizationSettings,
    } = await setupHarness({ initialLoadComplete: true, isManaged: true, deviceOverrides: { powerCapable: true } });

    expect(controllableCheckbox.getAttribute('aria-disabled')).not.toBe('true');
    expect(priceOptCheckbox.getAttribute('aria-disabled')).not.toBe('true');

    controllableCheckbox.click();
    priceOptCheckbox.click();
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

    expect(managedCheckbox.getAttribute('aria-checked')).toBe('true');
    expect(managedCheckbox.getAttribute('aria-disabled')).not.toBe('true');
    expect(controllableCheckbox.getAttribute('aria-disabled')).toBe('true');
    expect(priceOptCheckbox.getAttribute('aria-disabled')).not.toBe('true');
  });
});
