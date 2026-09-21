import type { SettingsUiDeviceDetailItem } from '../src/ui/deviceUtils.ts';
import type { AfterSetupFactsRead } from '../src/ui/afterSetupFacts.ts';
import {
  SETTINGS_UI_DEVICES_PATH,
  SETTINGS_UI_RECOMMENDATION_CARS_PATH,
  SETTINGS_UI_REFRESH_FLOW_CONFLICTS_PATH,
} from '../../contracts/src/settingsUiApi.ts';

const OTHER_MODULES_API_PATH = '/ui_hub_market';
const callApi = vi.fn();
const getSetting = vi.fn();
const getSettingFresh = vi.fn();
const setSetting = vi.fn();
const sleep = vi.fn().mockResolvedValue(undefined);
const logSettingsError = vi.fn().mockResolvedValue(undefined);
let afterSetupRead: AfterSetupFactsRead;
let publishHomeScopeChange = (): void => {
  throw new Error('Recommendations did not subscribe to home-scope changes.');
};

vi.mock('../src/ui/homey.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/homey.ts')>('../src/ui/homey.ts');
  return {
    ...actual,
    // Routed by path for the same reason as the settings below: this spec counts
    // the CAR inventory calls, and the hub-market read shares the seam.
    callApi: (...args: unknown[]) => {
      if (args[1] === OTHER_MODULES_API_PATH) return Promise.resolve({ state: 'unavailable' });
      return callApi(...args);
    },
    getSetting: (...args: unknown[]) => getSetting(...args),
    getSettingFresh: (...args: unknown[]) => getSettingFresh(...args),
    setSetting: (...args: unknown[]) => setSetting(...args),
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

vi.mock('../src/ui/setupPathFacts.ts', () => ({
  isBelgianHomeOnHourlyPeriod: () => false,
  notifySetupPathChange: () => undefined,
  onSetupPathChange: () => undefined,
  readSetupMarket: () => ({ state: 'unavailable' }),
  readSetupPath: () => ({ state: 'complete' }),
}));

vi.mock('../src/ui/afterSetupFacts.ts', () => ({
  loadAfterSetupFacts: () => Promise.resolve(),
  readAfterSetupFacts: () => afterSetupRead,
}));

vi.mock('../src/ui/homeScope.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/ui/homeScope.ts')>('../src/ui/homeScope.ts');
  return {
    ...actual,
    subscribeToHomeScope: (listener: () => void) => { publishHomeScopeChange = listener; },
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
    <div id="toast"></div>
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
  setSetting.mockResolvedValue(undefined);
  afterSetupRead = {
    state: 'resolved',
    facts: {
      setupComplete: true,
      devices: [],
      priceOptimizationEnabled: true,
      solarSurplusAvailable: false,
      smartTaskConfigured: false,
      market: { state: 'unavailable' },
      belgianHomeOnHourlyPeriod: false,
    },
  };
  publishHomeScopeChange = () => {
    throw new Error('Recommendations did not subscribe to home-scope changes.');
  };
});

describe('recommendation loading', () => {
  it('shows the global banner for disabled built-in control without Flow metadata', async () => {
    const recommendations = await loadSubject([device({
      controlAdapter: {
        kind: 'capability_adapter', activationAvailable: true,
        activationRequired: false, activationEnabled: false,
      },
    })]);
    getSetting.mockResolvedValue({});
    callApi.mockResolvedValue(resolvedCars());

    await recommendations.loadRecommendationData();

    expect(document.getElementById('setup-recommendations-banner-root')?.textContent)
      .toContain('1 recommendation');
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('If you use a Flow');
  });

  it('shows the built-in-control migration while optional car inventory is unavailable', async () => {
    const recommendations = await loadSubject([device({
      flowConflict: { conflictingCapabilities: ['target_charger_current'], flowName: 'Easee current' },
    })]);
    getSetting.mockResolvedValue({});
    callApi.mockResolvedValue({ state: 'unavailable' });

    await recommendations.loadRecommendationData();

    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('Use built-in device control for Connected 300');
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('Some recommendation checks couldn’t be refreshed right now');
  });

  it('does not claim an all-clear while Price setup facts are unavailable', async () => {
    const recommendations = await loadSubject([]);
    getSetting.mockResolvedValue({});
    callApi.mockResolvedValue(resolvedCars());
    afterSetupRead = { state: 'loading' };

    await recommendations.loadRecommendationData();

    const text = document.getElementById('setup-recommendations-root')?.textContent ?? '';
    expect(text).toContain('Some recommendation checks couldn’t be refreshed right now');
    expect(text).toContain('No suggestions from the checks that finished');
    expect(text).not.toContain('No setup suggestions right now');
  });

  it('redraws membership-dependent suggestions when Main-home ownership changes', async () => {
    const recommendations = await loadSubject([]);
    getSetting.mockResolvedValue({});
    callApi.mockResolvedValue(resolvedCars());
    afterSetupRead = {
      state: 'resolved',
      facts: {
        setupComplete: true,
        devices: [{
          temperature: true,
          limitable: false,
          taskCapable: true,
          priceConfigured: false,
          usesSolarSurplus: false,
        }],
        priceOptimizationEnabled: true,
        solarSurplusAvailable: false,
        smartTaskConfigured: false,
        market: { state: 'unavailable' },
        belgianHomeOnHourlyPeriod: false,
      },
    };

    await recommendations.loadRecommendationData();
    const listeners = vi.spyOn(document, 'addEventListener');
    recommendations.initRecommendationSurfaces({ openPanel: vi.fn(), openDevice: vi.fn() });
    try {
      const surface = document.getElementById('setup-recommendations-root');
      expect(surface?.textContent).toContain('Heat more while power is cheap');

      afterSetupRead = {
        state: 'resolved',
        facts: { ...afterSetupRead.facts, devices: [] },
      };
      publishHomeScopeChange();

      expect(surface?.textContent).not.toContain('Heat more while power is cheap');
      expect(surface?.textContent).toContain('No setup suggestions right now');
    } finally {
      for (const [type, listener, options] of listeners.mock.calls) {
        document.removeEventListener(type, listener, options);
      }
      listeners.mockRestore();
    }
  });

  it('rechecks a Flow conflict immediately and removes a cleared recommendation', async () => {
    const conflictedDevice = device({
      available: true,
      flowConflict: { conflictingCapabilities: ['setDynamicChargerCurrent'], flowName: 'Elbillader' },
      controlAdapter: {
        kind: 'capability_adapter', activationAvailable: true,
        activationRequired: false, activationEnabled: false,
      },
    });
    const recommendations = await loadSubject([conflictedDevice]);
    getSetting.mockResolvedValue({});
    callApi.mockImplementation(async (_method: string, path: string) => {
      if (path === SETTINGS_UI_RECOMMENDATION_CARS_PATH) return resolvedCars();
      if (path === SETTINGS_UI_REFRESH_FLOW_CONFLICTS_PATH) {
        return {
          devices: [{
            id: conflictedDevice.id,
            controlAdapter: { ...conflictedDevice.controlAdapter!, activationEnabled: true },
          }],
        };
      }
      return {};
    });

    await recommendations.loadRecommendationData();
    const listeners = vi.spyOn(document, 'addEventListener');
    recommendations.initRecommendationSurfaces({ openPanel: vi.fn(), openDevice: vi.fn() });
    try {
      const surface = document.getElementById('setup-recommendations-root');
      expect(surface?.textContent).toContain('Use built-in device control for Connected 300');
      const checkAgain = [...surface!.querySelectorAll('md-filled-tonal-button')]
        .find((button) => button.textContent?.trim() === 'Check again');

      checkAgain?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await vi.waitFor(() => {
        expect(surface?.textContent).not.toContain('Remove conflicting Flow control for Connected 300');
      });
      expect(callApi).toHaveBeenCalledWith('POST', SETTINGS_UI_REFRESH_FLOW_CONFLICTS_PATH, {});
      expect(surface?.textContent).toContain('No setup suggestions right now');
    } finally {
      for (const [type, listener, options] of listeners.mock.calls) {
        document.removeEventListener(type, listener, options);
      }
      listeners.mockRestore();
    }
  });

  it('disables every Flow-conflict action while the shared refresh is in flight', async () => {
    const flowConflict = {
      conflictingCapabilities: ['setDynamicChargerCurrent'],
      flowName: 'Elbillader',
    };
    const controlAdapter = {
      kind: 'capability_adapter' as const,
      activationAvailable: true,
      activationRequired: false,
      activationEnabled: true,
    };
    const firstDevice = device({ available: true, flowConflict, controlAdapter });
    const secondDevice = device({
      id: 'device-2',
      name: 'Garage charger',
      available: true,
      flowConflict,
      controlAdapter,
    });
    const unrelatedDevice = device({
      id: 'device-3',
      name: 'Heat pump',
      available: true,
      controlAdapter: { ...controlAdapter, activationEnabled: false },
    });
    const recommendations = await loadSubject([firstDevice, secondDevice, unrelatedDevice]);
    getSetting.mockResolvedValue({});
    let releaseRefresh: () => void = () => {};
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshAttempts = 0;
    callApi.mockImplementation(async (_method: string, path: string) => {
      if (path === SETTINGS_UI_RECOMMENDATION_CARS_PATH) return resolvedCars();
      if (path === SETTINGS_UI_REFRESH_FLOW_CONFLICTS_PATH) {
        refreshAttempts += 1;
        await refreshGate;
        return {
          devices: [firstDevice, secondDevice].map((entry) => ({
            id: entry.id,
            flowConflict: entry.flowConflict,
            controlAdapter: entry.controlAdapter,
          })),
        };
      }
      return {};
    });

    await recommendations.loadRecommendationData();
    const listeners = vi.spyOn(document, 'addEventListener');
    recommendations.initRecommendationSurfaces({ openPanel: vi.fn(), openDevice: vi.fn() });
    try {
      const surface = document.getElementById('setup-recommendations-root');
      const checkButtons = () => [...surface!.querySelectorAll('md-filled-tonal-button')]
        .filter((button) => ['Check again', 'Checking…'].includes(button.textContent?.trim() ?? ''));

      expect(checkButtons()).toHaveLength(2);
      checkButtons()[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await vi.waitFor(() => {
        expect(checkButtons()).toHaveLength(2);
        expect(checkButtons().every((button) => button.disabled)).toBe(true);
        const unrelatedAction = [...surface!.querySelectorAll('md-filled-tonal-button')]
          .find((button) => button.textContent?.trim() === 'Review device');
        expect(unrelatedAction?.disabled).toBe(false);
      });

      checkButtons()[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(refreshAttempts).toBe(1);

      releaseRefresh();
      await vi.waitFor(() => {
        expect(checkButtons().every((button) => !button.disabled)).toBe(true);
      });
    } finally {
      releaseRefresh();
      for (const [type, listener, options] of listeners.mock.calls) {
        document.removeEventListener(type, listener, options);
      }
      listeners.mockRestore();
    }
  });

  it('keeps the last good conflict after a malformed refresh and allows retry', async () => {
    const conflictedDevice = device({
      available: true,
      flowConflict: { conflictingCapabilities: ['setDynamicChargerCurrent'], flowName: 'Elbillader' },
      controlAdapter: {
        kind: 'capability_adapter', activationAvailable: true,
        activationRequired: false, activationEnabled: true,
      },
    });
    const recommendations = await loadSubject([conflictedDevice]);
    const { primeApiCache } = await import('../src/ui/homey.ts');
    primeApiCache(SETTINGS_UI_DEVICES_PATH, {
      devices: [conflictedDevice],
      chargerPhasePresets: { state: 'resolved', presets: {} },
      hasManagedSolarDevice: false,
      hasExhibitedExport: false,
      surplusPoolReachable: false,
    });
    getSetting.mockResolvedValue({});
    let refreshAttempts = 0;
    callApi.mockImplementation(async (_method: string, path: string) => {
      if (path === SETTINGS_UI_RECOMMENDATION_CARS_PATH) return resolvedCars();
      if (path === SETTINGS_UI_REFRESH_FLOW_CONFLICTS_PATH) {
        refreshAttempts += 1;
        return {
          devices: refreshAttempts === 1
            ? [{ available: true }]
            : [{
              id: conflictedDevice.id,
              flowConflict: refreshAttempts === 2
                ? { conflictingCapabilities: 'malformed' }
                : undefined,
              controlAdapter: refreshAttempts === 3
                ? { ...conflictedDevice.controlAdapter!, activationEnabled: 'malformed' }
                : refreshAttempts === 4
                  ? { ...conflictedDevice.controlAdapter!, activationEnabled: true }
                  : conflictedDevice.controlAdapter,
            }],
        };
      }
      return {};
    });

    await recommendations.loadRecommendationData();
    const listeners = vi.spyOn(document, 'addEventListener');
    recommendations.initRecommendationSurfaces({ openPanel: vi.fn(), openDevice: vi.fn() });
    try {
      const surface = document.getElementById('setup-recommendations-root');
      const clickCheckAgain = () => [...surface!.querySelectorAll('md-filled-tonal-button')]
        .find((button) => button.textContent?.trim() === 'Check again')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      clickCheckAgain();
      await vi.waitFor(() => {
        expect(refreshAttempts).toBe(1);
        expect(surface?.textContent).toContain('Check again');
      });
      expect(surface?.textContent).toContain('Remove conflicting Flow control for Connected 300');
      const { getTargetDevices } = await import('../src/ui/devices.ts');
      await expect(getTargetDevices()).resolves.toEqual([conflictedDevice]);

      clickCheckAgain();
      await vi.waitFor(() => {
        expect(refreshAttempts).toBe(2);
        expect(surface?.textContent).toContain('Check again');
      });
      expect(surface?.textContent).toContain('Remove conflicting Flow control for Connected 300');

      clickCheckAgain();
      await vi.waitFor(() => {
        expect(refreshAttempts).toBe(3);
        expect(surface?.textContent).toContain('Check again');
      });
      expect(surface?.textContent).toContain('Remove conflicting Flow control for Connected 300');

      clickCheckAgain();
      await vi.waitFor(() => {
        expect(surface?.textContent).not.toContain('Remove conflicting Flow control for Connected 300');
      });
      expect(refreshAttempts).toBe(4);
    } finally {
      for (const [type, listener, options] of listeners.mock.calls) {
        document.removeEventListener(type, listener, options);
      }
      listeners.mockRestore();
    }
  });

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

  it.each(['thrown', 'malformed'])('keeps known guidance on a cold %s dismissal read and allows retry', async (failure) => {
    const recommendations = await loadSubject([device({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
    })]);
    if (failure === 'thrown') {
      getSetting.mockRejectedValueOnce(new Error('settings unavailable'));
      getSettingFresh.mockRejectedValue(new Error('settings unavailable'));
    } else {
      getSetting.mockResolvedValueOnce('malformed');
      getSettingFresh.mockResolvedValue('malformed');
    }
    callApi.mockResolvedValue(resolvedCars());

    await recommendations.loadRecommendationData();

    const surface = document.getElementById('setup-recommendations-root');
    expect(surface?.textContent).toContain('Use built-in device control for Connected 300');
    expect(surface?.textContent).toContain('Dismissed recommendations couldn’t be read');
    expect(surface?.textContent).toContain('Try again');
    expect(surface?.textContent).not.toContain('Checking your configuration');
    expect(surface?.textContent).not.toContain('Some recommendation checks couldn’t be refreshed');
    expect([...surface!.querySelectorAll('md-text-button')].some((button) => button.textContent === 'Dismiss'))
      .toBe(false);
    expect(document.getElementById('setup-recommendations-banner-root')?.textContent).toBe('');
    expect(document.getElementById('settings-nav-chip-recommendations')?.hidden).toBe(true);
    expect(setSetting).not.toHaveBeenCalled();

    getSetting.mockResolvedValueOnce({});
    const retry = [...surface!.querySelectorAll('md-text-button')]
      .find((button) => button.textContent === 'Try again');
    retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(surface?.textContent).not.toContain('Dismissed recommendations couldn’t be read');
    });
    expect(getSetting).toHaveBeenCalledTimes(2);
  });

  it('refreshes added, renamed and removed cars without reloading dismissal settings', async () => {
    const recommendations = await loadSubject([device({ deviceClass: 'evcharger' })]);
    getSetting.mockResolvedValue({});
    callApi.mockResolvedValue(resolvedCars());
    await recommendations.loadRecommendationData();
    const listeners = vi.spyOn(document, 'addEventListener');
    recommendations.initRecommendationSurfaces({ openPanel: vi.fn(), openDevice: vi.fn() });
    const surface = document.getElementById('setup-recommendations-root');
    try {
      callApi.mockResolvedValue(resolvedCars([{ id: 'car-1', name: 'Polestar' }]));
      document.dispatchEvent(new Event('devices-updated'));
      await vi.waitFor(() => { expect(surface?.textContent).toContain('Choose a charger for Polestar'); });

      let resolveOldCars!: (value: ReturnType<typeof resolvedCars>) => void;
      callApi.mockReturnValueOnce(new Promise((resolve) => { resolveOldCars = resolve; }));
      const callsBeforeRefresh = callApi.mock.calls.length;
      document.dispatchEvent(new Event('devices-updated'));
      // Two more device changes during the read share one follow-up fetch.
      expect(surface?.textContent).not.toContain('Some recommendation checks couldn’t be refreshed');
      document.dispatchEvent(new Event('devices-updated'));
      document.dispatchEvent(new Event('devices-updated'));
      callApi.mockResolvedValue(resolvedCars([{ id: 'car-1', name: 'Current car' }]));
      resolveOldCars(resolvedCars([{ id: 'car-1', name: 'Obsolete car' }]));
      await vi.waitFor(() => { expect(surface?.textContent).toContain('Choose a charger for Current car'); });
      expect(surface?.textContent).not.toContain('Obsolete car');
      expect(callApi).toHaveBeenCalledTimes(callsBeforeRefresh + 2);

      callApi.mockResolvedValue(resolvedCars([{ id: 'car-1', name: 'Renamed car' }]));
      document.dispatchEvent(new CustomEvent('pels:tab-shown', { detail: { tabId: 'recommendations' } }));
      await vi.waitFor(() => { expect(surface?.textContent).toContain('Choose a charger for Renamed car'); });
      expect(surface?.textContent).not.toContain('Polestar');

      callApi.mockResolvedValue(resolvedCars());
      document.dispatchEvent(new Event('devices-updated'));
      await vi.waitFor(() => { expect(surface?.textContent).toContain('No setup suggestions right now'); });
      expect(surface?.textContent).not.toContain('Renamed car');
      expect(getSetting).toHaveBeenCalledOnce();
    } finally {
      for (const [type, listener, options] of listeners.mock.calls) {
        document.removeEventListener(type, listener, options);
      }
      listeners.mockRestore();
    }
  });

  it('shows available car guidance while the independent dismissal read is still pending', async () => {
    const recommendations = await loadSubject([device({ deviceClass: 'evcharger' })]);
    let resolveDismissals!: (value: Record<string, number>) => void;
    getSetting.mockReturnValueOnce(new Promise((resolve) => { resolveDismissals = resolve; }));
    callApi.mockResolvedValue(resolvedCars([{ id: 'car-1', name: 'Polestar' }]));

    const loading = recommendations.loadRecommendationData();
    try {
      await vi.waitFor(() => {
        expect(document.getElementById('setup-recommendations-root')?.textContent)
          .toContain('Choose a charger for Polestar');
      });
      expect(document.getElementById('setup-recommendations-banner-root')?.textContent).toBe('');
    } finally {
      resolveDismissals({ 'charger-car:car-1': 1 });
      await loading;
    }
    expect(document.getElementById('setup-recommendations-root')?.textContent).toContain('Dismissed');
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
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('Dismissed');

    recommendations.clearRecommendationDismissals();
    expect(document.getElementById('setup-recommendations-banner-root')?.textContent)
      .toContain('1 recommendation');
  });

  it('reloads only dismissals when their setting changes', async () => {
    const recommendations = await loadSubject([device({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
    })]);
    getSetting.mockResolvedValueOnce({});
    callApi.mockResolvedValue(resolvedCars());
    await recommendations.loadRecommendationData();
    const { createSettingsSetHandler } = await import('../src/ui/settingsChangeRouter.ts');
    getSetting.mockResolvedValueOnce({ 'built-in-control:device-1': 1 });

    createSettingsSetHandler()('setup_recommendation_dismissals');

    await vi.waitFor(() => {
      expect(document.getElementById('setup-recommendations-root')?.textContent).toContain('Dismissed');
    });
    expect(getSetting).toHaveBeenCalledTimes(2);
    expect(callApi).toHaveBeenCalledOnce();
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

  it('does not let an older dismissal read undo a completed dismissal write', async () => {
    const recommendations = await loadSubject([device({
      flowConflict: { conflictingCapabilities: ['max_power_3000'] },
    })]);
    callApi.mockResolvedValue(resolvedCars());
    getSetting.mockResolvedValueOnce({});
    await recommendations.loadRecommendationData();

    let resolveSetting!: (value: unknown) => void;
    getSetting.mockReturnValueOnce(new Promise((resolve) => { resolveSetting = resolve; }));
    getSettingFresh.mockResolvedValueOnce({});

    const loading = recommendations.loadRecommendationData();
    const dismiss = [...document.querySelectorAll('md-text-button')]
      .find((button) => button.textContent?.trim() === 'Dismiss');
    dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(
        'setup_recommendation_dismissals',
        { 'built-in-control:device-1': 1 },
      );
    });

    resolveSetting({});
    await loading;

    expect(document.getElementById('setup-recommendations-banner-root')?.textContent).toBe('');
    expect(document.getElementById('setup-recommendations-root')?.textContent).toContain('Dismissed');
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
      .toContain('Choose a charger for Polestar 3');

    callApi.mockResolvedValue({ state: 'unavailable' });
    await recommendations.loadRecommendationData();
    expect(callApi).toHaveBeenCalledTimes(4);
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('Choose a charger for Polestar 3');
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('Some recommendation checks couldn’t be refreshed right now');

    callApi.mockResolvedValue(resolvedCars());
    await recommendations.loadRecommendationData();
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('No setup suggestions right now');
  });

  it('does not claim an all-clear when a last-good empty car inventory becomes unavailable', async () => {
    const recommendations = await loadSubject([]);
    getSetting.mockResolvedValue({});
    callApi.mockResolvedValueOnce(resolvedCars());

    await recommendations.loadRecommendationData();
    expect(document.getElementById('setup-recommendations-root')?.textContent)
      .toContain('No setup suggestions right now');

    callApi.mockResolvedValue({ state: 'unavailable' });
    await recommendations.loadRecommendationData();

    const text = document.getElementById('setup-recommendations-root')?.textContent;
    expect(text).toContain('Some recommendation checks couldn’t be refreshed right now');
    expect(text).toContain('No suggestions from the checks that finished');
    expect(text).not.toContain('No setup suggestions right now');
  });
});
