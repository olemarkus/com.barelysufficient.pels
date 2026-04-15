import type { TargetDeviceSnapshot } from '../../contracts/src/types';

const setupDom = () => {
  document.body.innerHTML = `
    <div id="device-list"></div>
    <p id="empty-state"></p>
    <button id="refresh-button"></button>
  `;
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
