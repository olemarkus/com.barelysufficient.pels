import type { SettingsUiDeviceDetailItem } from '../src/ui/deviceUtils.ts';

const callApi = vi.fn();
const getSetting = vi.fn();
const getSettingFresh = vi.fn();
const sleep = vi.fn().mockResolvedValue(undefined);
const logSettingsError = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/ui/homey.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/homey.ts')>('../src/ui/homey.ts');
  return {
    ...actual,
    callApi: (...args: unknown[]) => callApi(...args),
    getSetting: (...args: unknown[]) => getSetting(...args),
    getSettingFresh: (...args: unknown[]) => getSettingFresh(...args),
    sleep: (...args: unknown[]) => sleep(...args),
  };
});

vi.mock('../src/ui/logging.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/logging.ts')>('../src/ui/logging.ts');
  return {
    ...actual,
    logSettingsError: (...args: unknown[]) => logSettingsError(...args),
  };
});

const device = (overrides: Partial<SettingsUiDeviceDetailItem> = {}): SettingsUiDeviceDetailItem => ({
  id: 'device-1',
  name: 'Connected 300',
  targets: [],
  ...overrides,
} as SettingsUiDeviceDetailItem);

const installSurfaces = () => {
  document.body.innerHTML = `
    <div id="setup-recommendations-banner-root"></div>
    <div id="setup-recommendations-root"></div>
    <span id="settings-nav-chip-recommendations"></span>
  `;
};

const loadSubject = async (devices: SettingsUiDeviceDetailItem[]) => {
  const [{ state }, recommendations] = await Promise.all([
    import('../src/ui/state.ts'),
    import('../src/ui/recommendations.ts'),
  ]);
  state.devicesLoaded = true;
  state.latestDevices = devices;
  state.evCarAssociations = {};
  state.evCarAssociationsLoaded = true;
  state.nativeWiringMap = {};
  return recommendations;
};

const resolvedCars = (cars: Array<{ id: string; name: string }> = []) => ({
  state: 'resolved' as const,
  cars,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  installSurfaces();
  sleep.mockResolvedValue(undefined);
  getSettingFresh.mockResolvedValue(undefined);
});

describe('recommendation loading', () => {
  it('retries a cold-start dismissal gap before treating the setting as absent', async () => {
    const recommendations = await loadSubject([device({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
    })]);
    getSetting.mockResolvedValueOnce(undefined);
    getSettingFresh.mockResolvedValueOnce({ 'built-in-control:device-1': 1 });
    callApi.mockResolvedValue(resolvedCars());

    await recommendations.loadRecommendationData();

    expect(getSettingFresh).toHaveBeenCalledWith('setup_recommendation_dismissals');
    expect(document.getElementById('setup-recommendations-banner-root')?.textContent).toBe('');
  });

  it('preserves last-good dismissals on an unavailable read and clears them on explicit unset', async () => {
    const recommendations = await loadSubject([device({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
    })]);
    getSetting.mockResolvedValueOnce({ 'built-in-control:device-1': 1 });
    callApi.mockResolvedValue(resolvedCars());

    await recommendations.loadRecommendationData();
    expect(document.getElementById('setup-recommendations-banner-root')?.textContent).toBe('');

    getSetting.mockResolvedValueOnce(undefined);
    getSettingFresh.mockResolvedValue(undefined);
    await recommendations.loadRecommendationData();
    expect(document.getElementById('setup-recommendations-banner-root')?.textContent).toBe('');

    recommendations.clearRecommendationDismissals();
    expect(document.getElementById('setup-recommendations-banner-root')?.textContent)
      .toContain('1 recommendation');
  });

  it('does not let an older dismissal read undo an explicit unset', async () => {
    const recommendations = await loadSubject([device({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
    })]);
    callApi.mockResolvedValue(resolvedCars());
    getSetting.mockResolvedValueOnce({ 'built-in-control:device-1': 1 });
    await recommendations.loadRecommendationData();

    let resolveSetting!: (value: unknown) => void;
    getSetting.mockReturnValueOnce(new Promise((resolve) => { resolveSetting = resolve; }));

    const loading = recommendations.loadRecommendationData();
    recommendations.clearRecommendationDismissals();
    resolveSetting({ 'built-in-control:device-1': 1 });
    await loading;

    expect(document.getElementById('setup-recommendations-banner-root')?.textContent)
      .toContain('1 recommendation');
  });

  it('preserves last-good cars while unavailable and accepts a later resolved empty inventory', async () => {
    const recommendations = await loadSubject([device({
      id: 'charger-1',
      name: 'Easee',
      deviceClass: 'evcharger',
    })]);
    getSetting.mockResolvedValue({});
    callApi.mockResolvedValue(resolvedCars([{ id: 'car-1', name: 'Polestar 3' }]));

    await recommendations.loadRecommendationData();
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('Connect Polestar 3 to a charger');

    callApi.mockResolvedValue({ state: 'unavailable' });
    await recommendations.loadRecommendationData();
    expect(callApi).toHaveBeenCalledTimes(4);
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('Connect Polestar 3 to a charger');

    callApi.mockResolvedValue(resolvedCars());
    await recommendations.loadRecommendationData();
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('You’re all set');
  });
});
