import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';

// A home battery's Power-limit control lives in `controllable_devices` like a
// load's, but reads through the battery's own gate: absent is on, `false` is
// off, and the switch is offered only while the battery is managed.

const store = new Map<string, unknown>();
const debouncedSetSetting = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/ui/homey.ts', () => ({
  getSettingFresh: async (key: string) => store.get(key),
  setSetting: async (key: string, value: unknown) => { store.set(key, value); },
  callApi: vi.fn(),
  getApiReadModel: vi.fn(),
  invalidateApiCache: vi.fn(),
  invalidateApiCacheForAllHomes: vi.fn(),
  invalidateApiCacheForScopedHomes: vi.fn(),
  primeApiCache: vi.fn(),
}));
vi.mock('../src/ui/utils.ts', () => ({ debouncedSetSetting: (...args: unknown[]) => debouncedSetSetting(...args) }));
vi.mock('../src/ui/modes.ts', () => ({ renderPriorities: vi.fn() }));
vi.mock('../src/ui/priceOptimization.ts', () => ({
  renderPriceOptimization: vi.fn(),
  savePriceOptimizationSettings: vi.fn(),
}));
vi.mock('../src/ui/plan.ts', () => ({ refreshPlan: vi.fn() }));
vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
  logSettingsWarn: vi.fn().mockResolvedValue(undefined),
}));

const battery = withDescriptorIdentity<TargetDeviceSnapshot>({
  id: 'battery-1',
  name: 'Home battery',
  deviceClass: 'battery',
  available: true,
  targets: [],
  capabilities: ['measure_power'],
  expectedPowerKw: 0,
  expectedPowerSource: 'default',
});

const heater = withDescriptorIdentity<TargetDeviceSnapshot>({
  id: 'heater-1',
  name: 'Heater',
  deviceClass: 'heater',
  deviceType: 'onoff',
  available: true,
  targets: [],
  capabilities: ['measure_power', 'onoff'],
  powerCapable: true,
  expectedPowerKw: 1,
  expectedPowerSource: 'default',
});

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

const loadState = async (managed: Record<string, boolean>, controllable: Record<string, boolean>) => {
  const module = await import('../src/ui/state.ts');
  module.state.initialLoadComplete = true;
  module.state.latestDevices = [battery];
  module.state.managedMap = {};
  module.state.batteryControl = { status: 'resolved', devices: managed };
  module.state.controllableMap = controllable;
  module.state.priceOptimizationSettings = {};
  module.state.budgetExemptMap = {};
  return module;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  store.clear();
});

// The device-page write test stubs the device list; a doMock outlives resetModules.
afterEach(() => {
  vi.doUnmock('../src/ui/devices.ts');
});

describe('battery Power-limit control read', () => {
  it('reads an absent entry as on and false as off', async () => {
    const { resolveBatteryPowerLimitOn } = await loadState({}, {});
    expect(resolveBatteryPowerLimitOn('battery-1')).toBe(true);
    await loadState({}, { 'battery-1': false });
    expect(resolveBatteryPowerLimitOn('battery-1')).toBe(false);
  });

  it('reads off while the battery is not managed or its Managed map does not parse', async () => {
    const { resolveBatteryPowerLimitOn, state } = await loadState({ 'battery-1': false }, { 'battery-1': true });
    expect(resolveBatteryPowerLimitOn('battery-1')).toBe(false);
    state.batteryControl = { status: 'unreadable' };
    expect(resolveBatteryPowerLimitOn('battery-1')).toBe(false);
  });
});

describe('battery device page', () => {
  it('greys the switch out while Managed is off', async () => {
    await loadState({ 'battery-1': false }, {});
    const { resolveDeviceDetailControlState, setPowerLimitSwitch } = await import(
      '../src/ui/deviceDetail/controlState.ts'
    );
    const switchFor = () => {
      const switchEl = { selected: false, disabled: false };
      setPowerLimitSwitch(switchEl, resolveDeviceDetailControlState(battery, 'battery-1'), 'battery-1');
      return switchEl;
    };
    expect(switchFor()).toEqual({ selected: false, disabled: true });
    const { state } = await import('../src/ui/state.ts');
    state.batteryControl = { status: 'unreadable' };
    expect(switchFor()).toEqual({ selected: false, disabled: true });
    state.batteryControl = { status: 'resolved', devices: {} };
    expect(switchFor()).toEqual({ selected: true, disabled: false });
  });

  it('moves the switch under Managed on a battery page and back for any other device', async () => {
    document.body.innerHTML = `
      <section id="device-detail-modes-section"></section>
      <section id="device-detail-battery-section">
        <div id="device-detail-battery-list">
          <div id="device-detail-battery-takeover-notice"></div>
          <div id="device-detail-battery-priority-row"></div>
        </div>
      </section>
      <section id="device-detail-setup-section">
        <div id="setup-list">
          <div id="device-detail-managed-row"></div>
          <div id="device-detail-temperature-control-disabled-row"></div>
          <div id="device-detail-controllable-row"></div>
          <div id="device-detail-start-policy-row"></div>
        </div>
      </section>
    `;
    await loadState({}, {});
    const layout = await import('../src/ui/deviceDetail/sectionLayout.ts');
    layout.resetDeviceDetailSectionLayoutForTest();
    const ids = (listId: string) => Array.from(document.getElementById(listId)!.children).map((el) => el.id);

    layout.applyDeviceDetailSectionLayout(battery);
    expect(ids('device-detail-battery-list')).toEqual([
      'device-detail-battery-takeover-notice',
      'device-detail-managed-row',
      'device-detail-controllable-row',
      'device-detail-battery-priority-row',
    ]);

    layout.applyDeviceDetailSectionLayout(heater);
    expect(ids('setup-list')).toEqual([
      'device-detail-managed-row',
      'device-detail-temperature-control-disabled-row',
      'device-detail-controllable-row',
      'device-detail-start-policy-row',
    ]);
  });

  it('writes an explicit false when the owner turns it off', async () => {
    vi.doMock('../src/ui/devices.ts', () => ({ renderDevices: vi.fn() }));
    document.body.innerHTML = `
      <md-switch id="device-detail-managed"></md-switch>
      <md-switch id="device-detail-controllable"></md-switch>
    `;
    const { state } = await loadState({}, {});
    store.set('controllable_devices', {});
    const { initDeviceDetailManagedControlHandlers } = await import('../src/ui/deviceDetail/managedControl.ts');
    initDeviceDetailManagedControlHandlers(() => 'battery-1', vi.fn(), vi.fn(), vi.fn());

    const limitSwitch = document.getElementById('device-detail-controllable') as HTMLElement & { selected: boolean };
    limitSwitch.selected = false;
    limitSwitch.dispatchEvent(new Event('change'));
    await flush();

    expect(store.get('controllable_devices')).toEqual({ 'battery-1': false });
    expect(state.controllableMap).toEqual({ 'battery-1': false });
  });
});

describe('battery device list row', () => {
  const renderLimitToggle = async (managed: Record<string, boolean>, controllable: Record<string, boolean>) => {
    document.body.innerHTML = `
      <div id="device-card-list"></div>
      <div id="empty-state"></div>
      <md-outlined-button id="refresh-button"></md-outlined-button>
    `;
    const { state } = await loadState(managed, controllable);
    const { renderDevices } = await import('../src/ui/devices.ts');
    renderDevices([battery]);
    const row = document.querySelector<HTMLElement>('[data-device-id="battery-1"]');
    const [, limit, price] = Array.from(row?.querySelectorAll<HTMLElement>('.pels-icon-toggle') ?? []);
    if (!limit || !price) throw new Error('Row toggles not found.');
    return { state, limit, price };
  };

  it('offers Limit as on by default while the battery is managed, and Price as not applicable', async () => {
    const { limit, price } = await renderLimitToggle({}, {});
    expect(limit.getAttribute('aria-checked')).toBe('true');
    expect(limit.getAttribute('aria-disabled')).toBeNull();
    expect(price.getAttribute('aria-disabled')).toBe('true');
  });

  it('greys Limit out while Managed is off', async () => {
    const { limit } = await renderLimitToggle({ 'battery-1': false }, {});
    expect(limit.getAttribute('aria-checked')).toBe('false');
    expect(limit.getAttribute('aria-disabled')).toBe('true');
    expect(limit.getAttribute('aria-label')).toBe('Power-limit control (requires Managed by PELS)');
  });

  it('writes an explicit false when the owner turns Limit off', async () => {
    const { state, limit } = await renderLimitToggle({}, {});
    limit.click();
    await flush();
    expect(state.controllableMap).toEqual({ 'battery-1': false });
    expect(debouncedSetSetting).toHaveBeenCalledWith('controllable_devices', expect.any(Function));
    const buildValue = debouncedSetSetting.mock.calls[0]?.[1] as () => unknown;
    expect(buildValue()).toEqual({ 'battery-1': false });
  });
});
