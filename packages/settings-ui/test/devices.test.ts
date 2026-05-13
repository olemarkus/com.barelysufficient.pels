import type { TargetDeviceSnapshot } from '../../contracts/src/types';

const setupDom = () => {
  const root = document.body;
  root.replaceChildren();
  const deviceListEl = document.createElement('div');
  deviceListEl.id = 'device-list';
  const cardListEl = document.createElement('div');
  cardListEl.id = 'device-card-list';
  const emptyStateEl = document.createElement('p');
  emptyStateEl.id = 'empty-state';
  const refreshBtn = document.createElement('button');
  refreshBtn.id = 'refresh-button';
  root.append(deviceListEl, cardListEl, emptyStateEl, refreshBtn);
};

const mockSharedModules = () => {
  vi.doMock('../src/ui/modes.ts', () => ({
    renderPriorities: vi.fn(),
  }));
  vi.doMock('../src/ui/priceOptimization.ts', () => ({
    renderPriceOptimization: vi.fn(),
    savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/ui/plan.ts', () => ({
    refreshPlan: vi.fn(),
  }));
  vi.doMock('../src/ui/toast.ts', () => ({
    showToast: vi.fn().mockResolvedValue(undefined),
    showToastError: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/ui/logging.ts', () => ({
    logSettingsError: vi.fn().mockResolvedValue(undefined),
    logSettingsWarn: vi.fn().mockResolvedValue(undefined),
  }));
};

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'device-1',
  name: 'Test Device',
  targets: [],
  deviceType: 'temperature',
  currentOn: true,
  ...overrides,
});

describe('devices render', () => {
  beforeEach(() => {
    vi.resetModules();
    setupDom();
  });

  it('renders unavailable devices with a gray badge', async () => {
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/plan.ts', () => ({
      refreshPlan: vi.fn(),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToast: vi.fn().mockResolvedValue(undefined),
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
      logSettingsWarn: vi.fn().mockResolvedValue(undefined),
    }));

    const { renderDevices } = await import('../src/ui/devices.ts');
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.latestDevices = [buildDevice({ available: false })];
    state.budgetExemptMap = {};

    renderDevices(state.latestDevices);

    const row = document.querySelector('[data-device-id="device-1"]') as HTMLElement | null;
    expect(row?.textContent).toContain('Unavailable');
    expect(row?.querySelector('.device-row__state-chip')?.textContent).toBe('Unavailable');
    expect(row?.querySelector('.device-row__state-chip')?.getAttribute('data-tooltip')).toBe('Device is currently unavailable in Homey.');
    expect(row?.querySelector('.device-row__state-chip')?.getAttribute('title')).toBeNull();
  });

  it('renders budget-exempt devices with a gray badge', async () => {
    vi.doMock('../src/ui/modes.ts', () => ({
      renderPriorities: vi.fn(),
    }));
    vi.doMock('../src/ui/priceOptimization.ts', () => ({
      renderPriceOptimization: vi.fn(),
      savePriceOptimizationSettings: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/plan.ts', () => ({
      refreshPlan: vi.fn(),
    }));
    vi.doMock('../src/ui/toast.ts', () => ({
      showToast: vi.fn().mockResolvedValue(undefined),
      showToastError: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../src/ui/logging.ts', () => ({
      logSettingsError: vi.fn().mockResolvedValue(undefined),
      logSettingsWarn: vi.fn().mockResolvedValue(undefined),
    }));

    const { renderDevices } = await import('../src/ui/devices.ts');
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.latestDevices = [buildDevice()];
    state.budgetExemptMap = { 'device-1': true };

    renderDevices(state.latestDevices);

    const row = document.querySelector('[data-device-id="device-1"]') as HTMLElement | null;
    expect(row?.textContent).toContain('Budget exempt');
    expect(row?.querySelector('.device-row__state-chip')?.textContent).toBe('Budget exempt');
    expect(row?.querySelector('.device-row__state-chip')?.getAttribute('data-tooltip')).toBe('This device is excluded from daily budget limits.');
    expect(row?.querySelector('.device-row__state-chip')?.getAttribute('title')).toBeNull();
  });
});

describe('devices render — redesign shell', () => {
  beforeEach(() => {
    vi.resetModules();
    setupDom();
    mockSharedModules();
  });

  const importDevicesInRedesign = async () => {
    return import('../src/ui/devices.ts');
  };

  it('renders one surface card per device class with managed count chip', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.managedMap = { 'heater-1': true };
    state.controllableMap = {};
    state.priceOptimizationSettings = {};
    state.budgetExemptMap = {};
    state.latestDevices = [
      buildDevice({ id: 'heater-1', name: 'Hall heater', deviceClass: 'heater' }),
      buildDevice({ id: 'heater-2', name: 'Bath heater', deviceClass: 'heater' }),
      buildDevice({ id: 'evcharger-1', name: 'EV', deviceClass: 'evcharger' }),
    ];

    renderDevices(state.latestDevices);

    const cards = document.querySelectorAll<HTMLElement>('#device-card-list .pels-device-card');
    expect(cards.length).toBe(2);
    const heaterCard = Array.from(cards).find(
      (c) => c.dataset.deviceClass === 'heater',
    );
    expect(heaterCard?.querySelector('.plan-card__title')?.textContent).toBe('Heater');
    expect(heaterCard?.querySelector('.pels-device-card__count-chip')?.textContent).toBe(
      '1 of 2 managed',
    );
    expect(heaterCard?.querySelectorAll('.pels-device-card__row').length).toBe(2);
  });

  it('renders three switches per row reflecting managed/limit/price state', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.managedMap = { 'h1': true };
    state.controllableMap = { 'h1': true };
    state.priceOptimizationSettings = { 'h1': { enabled: false, cheapDelta: 5, expensiveDelta: -5 } };
    state.budgetExemptMap = {};
    state.latestDevices = [
      buildDevice({ id: 'h1', name: 'Heater', deviceClass: 'heater', powerCapable: true, loadKw: 1 }),
    ];

    renderDevices(state.latestDevices);

    const row = document.querySelector<HTMLElement>('[data-device-id="h1"]');
    const inputs = row?.querySelectorAll<HTMLButtonElement>('.pels-icon-toggle');
    expect(inputs?.length).toBe(3);
    expect(inputs?.[0]?.getAttribute('aria-checked')).toBe('true'); // managed
    expect(inputs?.[1]?.getAttribute('aria-checked')).toBe('true'); // limit
    expect(inputs?.[2]?.getAttribute('aria-checked')).toBe('false'); // price
  });

  it('disables limit and price switches when device is unmanageable', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.managedMap = {};
    state.controllableMap = {};
    state.priceOptimizationSettings = {};
    state.budgetExemptMap = {};
    // sensor with no temperature target and no power → unmanageable
    state.latestDevices = [
      buildDevice({ id: 'sensor-1', name: 'Sensor', deviceClass: 'sensor', deviceType: undefined, targets: [] }),
    ];

    renderDevices(state.latestDevices);

    const row = document.querySelector<HTMLElement>('[data-device-id="sensor-1"]');
    expect(row?.classList.contains('pels-device-card__row--unmanageable')).toBe(true);
    const inputs = row?.querySelectorAll<HTMLButtonElement>('.pels-icon-toggle');
    inputs?.forEach((input) => expect(input.getAttribute('aria-disabled')).toBe('true'));
  });

  it('opens device detail only from the explicit settings button', async () => {
    const { renderDevices } = await importDevicesInRedesign();
    const { state } = await import('../src/ui/state.ts');

    state.initialLoadComplete = true;
    state.managedMap = {};
    state.controllableMap = {};
    state.priceOptimizationSettings = {};
    state.budgetExemptMap = {};
    state.latestDevices = [buildDevice({ id: 'h1', name: 'Heater', deviceClass: 'heater' })];

    renderDevices(state.latestDevices);

    const handler = vi.fn();
    document.addEventListener('open-device-detail', handler);

    const nameEl = document.querySelector<HTMLElement>('[data-device-id="h1"] .device-row__title');
    nameEl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handler).not.toHaveBeenCalled();

    const detailButton = document.querySelector<HTMLElement>('[data-device-id="h1"] .pels-device-card__detail-button');
    detailButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(handler).toHaveBeenCalled();
    document.removeEventListener('open-device-detail', handler);
  });
});
