import { createSettingsHandler, type SettingsHandlerDeps } from '../lib/utils/settingsHandlers';
import {
  BUDGET_EXEMPT_DEVICES,
  CAPACITY_LIMIT_KW,
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_RESET,
  DEBUG_LOGGING_TOPICS,
  DEVICE_COMMUNICATION_MODELS,
  DEVICE_DRIVER_OVERRIDES,
  MANAGED_DEVICES,
} from '../lib/utils/settingsKeys';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const buildDeps = (overrides: Partial<SettingsHandlerDeps> = {}): SettingsHandlerDeps => {
  const homey = {
    settings: {
      get: vi.fn(),
      set: vi.fn(),
    },
  } as unknown as SettingsHandlerDeps['homey'];

  return {
    homey,
    loadCapacitySettings: vi.fn(),
    rebuildPlanFromCache: vi.fn().mockResolvedValue(undefined),
    refreshTargetDevicesSnapshot: vi.fn().mockResolvedValue(undefined),
    loadPowerTracker: vi.fn(),
    getCapacityGuard: vi.fn().mockReturnValue(undefined),
    getCapacitySettings: vi.fn().mockReturnValue({ limitKw: 10, marginKw: 1 }),
    getCapacityDryRun: vi.fn().mockReturnValue(false),
    loadPriceOptimizationSettings: vi.fn(),
    loadDailyBudgetSettings: vi.fn(),
    updateDailyBudgetState: vi.fn(),
    resetDailyBudgetLearning: vi.fn(),
    priceService: {
      refreshGridTariffData: vi.fn().mockResolvedValue(undefined),
      refreshSpotPrices: vi.fn().mockResolvedValue(undefined),
      updateCombinedPrices: vi.fn(),
    },
    updatePriceOptimizationEnabled: vi.fn(),
    updateOverheadToken: vi.fn().mockResolvedValue(undefined),
    updateDebugLoggingEnabled: vi.fn(),
    getExperimentalEvSupportEnabled: vi.fn().mockReturnValue(false),
    disableManagedEvDevices: vi.fn(),
    restartHomeyEnergyPoll: vi.fn(),
    log: vi.fn(),
    errorLog: vi.fn(),
    ...overrides,
  };
};

describe('createSettingsHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores unknown keys', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('unknown_key');

    expect(deps.loadCapacitySettings).not.toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('handles mode target updates and rebuilds', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('mode_device_targets');

    expect(deps.loadCapacitySettings).toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('logs and still rebuilds if mode target refresh fails', async () => {
    const deps = buildDeps({
      refreshTargetDevicesSnapshot: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const handler = createSettingsHandler(deps);

    await handler('mode_device_targets');

    expect(deps.errorLog).toHaveBeenCalledWith(
      'Failed to refresh devices after mode target change',
      expect.any(Error),
    );
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('updates capacity limit settings and overhead token', async () => {
    const guard = {
      setLimit: vi.fn(),
      setSoftMargin: vi.fn(),
    };
    const deps = buildDeps({
      getCapacityGuard: vi.fn().mockReturnValue(guard),
      getCapacitySettings: vi.fn().mockReturnValue({ limitKw: 12, marginKw: 0.5 }),
    });
    const handler = createSettingsHandler(deps);

    await handler(CAPACITY_LIMIT_KW);

    expect(guard.setLimit).toHaveBeenCalledWith(12);
    expect(guard.setSoftMargin).toHaveBeenCalledWith(0.5);
    expect(deps.updateOverheadToken).toHaveBeenCalledWith(0.5);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('reloads capacity settings and rebuilds when device communication models change', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(DEVICE_COMMUNICATION_MODELS);

    expect(deps.loadCapacitySettings).toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('reloads capacity settings, refreshes snapshot, and rebuilds when device driver overrides change', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(DEVICE_DRIVER_OVERRIDES);

    expect(deps.loadCapacitySettings).toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith(`settings:${DEVICE_DRIVER_OVERRIDES}`);
  });

  it('logs when a refresh snapshot fails', async () => {
    const deps = buildDeps({
      refreshTargetDevicesSnapshot: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const handler = createSettingsHandler(deps);

    await handler('refresh_target_devices_snapshot');

    expect(deps.errorLog).toHaveBeenCalledWith(
      'Failed to refresh target devices snapshot',
      expect.any(Error),
    );
  });

  it('logs when grid tariff refresh fails', async () => {
    const deps = buildDeps({
      priceService: {
        refreshGridTariffData: vi.fn().mockRejectedValue(new Error('fail')),
        refreshSpotPrices: vi.fn().mockResolvedValue(undefined),
        updateCombinedPrices: vi.fn(),
      },
    });
    const handler = createSettingsHandler(deps);

    await handler('refresh_nettleie');

    expect(deps.errorLog).toHaveBeenCalledWith('Failed to refresh grid tariff data', expect.any(Error));
  });

  it('routes settings UI log entries by level', async () => {
    const errorLog = vi.fn() as vi.MockedFunction<SettingsHandlerDeps['errorLog']>;
    const deps = buildDeps({ errorLog });
    deps.homey.settings.get = vi.fn()
      .mockReturnValueOnce({ level: 'error', message: 'Bad', detail: 'Detail', context: 'Form' })
      .mockReturnValueOnce({ level: 'warn', message: 'Heads up' })
      .mockReturnValueOnce({ level: 'info', message: 'Ok', detail: 'Done' });
    const handler = createSettingsHandler(deps);

    await handler('settings_ui_log');
    await handler('settings_ui_log');
    await handler('settings_ui_log');

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Settings UI'), expect.any(Error));
    const loggedError = errorLog.mock.calls[0][1] as Error;
    expect(loggedError.message).toBe('Detail');
    expect(deps.log).toHaveBeenCalledTimes(2);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Warning:'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Settings UI'));
    expect(deps.homey.settings.set).toHaveBeenCalledTimes(3);
    expect(deps.homey.settings.set).toHaveBeenCalledWith('settings_ui_log', null);
  });

  it('ignores invalid settings UI log payloads', async () => {
    const deps = buildDeps();
    deps.homey.settings.get = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ level: 'warn' });
    const handler = createSettingsHandler(deps);

    await handler('settings_ui_log');
    await handler('settings_ui_log');

    expect(deps.log).not.toHaveBeenCalled();
    expect(deps.errorLog).not.toHaveBeenCalled();
    expect(deps.homey.settings.set).not.toHaveBeenCalled();
  });

  it('logs handler failures and continues', async () => {
    const deps = buildDeps({
      rebuildPlanFromCache: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const handler = createSettingsHandler(deps);

    await handler('capacity_priorities');

    expect(deps.errorLog).toHaveBeenCalledWith('Settings handler failed', expect.any(Error));
  });

  it('handles debug logging toggle keys', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('debug_logging_enabled');
    await handler(DEBUG_LOGGING_TOPICS);

    expect(deps.updateDebugLoggingEnabled).toHaveBeenCalledTimes(2);
  });

  it('recomputes combined prices when price threshold changes', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('price_threshold_percent');

    expect(deps.priceService.updateCombinedPrices).toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('recomputes combined prices when minimum price difference changes', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('price_min_diff_ore');

    expect(deps.priceService.updateCombinedPrices).toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('recomputes combined prices when provider surcharge changes', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('provider_surcharge');

    expect(deps.priceService.updateCombinedPrices).toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('skips repeated no-op writes for deduped settings keys', async () => {
    const deps = buildDeps();
    deps.homey.settings.get = vi.fn().mockReturnValue(25);
    const handler = createSettingsHandler(deps);

    await handler('price_threshold_percent');
    await handler('price_threshold_percent');

    expect(deps.priceService.updateCombinedPrices).toHaveBeenCalledTimes(1);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('processes deduped settings keys again when value changes', async () => {
    const deps = buildDeps();
    const values = [25, 30];
    deps.homey.settings.get = vi.fn(() => values.shift());
    const handler = createSettingsHandler(deps);

    await handler('price_threshold_percent');
    await handler('price_threshold_percent');

    expect(deps.priceService.updateCombinedPrices).toHaveBeenCalledTimes(2);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(2);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  it('debounces combined price updates into one daily budget sync', async () => {
    vi.useFakeTimers();
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(COMBINED_PRICES);
    await handler(COMBINED_PRICES);

    expect(deps.updateDailyBudgetState).not.toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('coalesces combined price updates while a sync is still running', async () => {
    vi.useFakeTimers();
    let resolveFirstRebuild: (() => void) | null = null;
    const firstRebuildPromise = new Promise<void>((resolve) => {
      resolveFirstRebuild = resolve;
    });
    const deps = buildDeps({
      rebuildPlanFromCache: vi.fn()
        .mockImplementationOnce(() => firstRebuildPromise)
        .mockResolvedValue(undefined),
    });
    const handler = createSettingsHandler(deps);

    const first = handler(COMBINED_PRICES);
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    const second = handler(COMBINED_PRICES);
    const third = handler(COMBINED_PRICES);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    resolveFirstRebuild?.();
    await flushMicrotasks();

    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    await Promise.all([first, second, third]);

    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(2);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(2);
  });

  it('debounces daily budget setting writes into one sync and rebuild', async () => {
    vi.useFakeTimers();
    const settingsStore: Record<string, unknown> = {
      [DAILY_BUDGET_KWH]: 40,
      [DAILY_BUDGET_ENABLED]: true,
    };
    const deps = buildDeps();
    deps.homey.settings.get = vi.fn((key: string) => settingsStore[key]);
    const handler = createSettingsHandler(deps);

    const first = handler(DAILY_BUDGET_KWH);
    const second = handler(DAILY_BUDGET_ENABLED);
    await Promise.all([first, second]);

    expect(deps.loadDailyBudgetSettings).not.toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).not.toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    await flushMicrotasks();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(deps.loadDailyBudgetSettings).toHaveBeenCalledTimes(1);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith('settings:daily_budget_settings');
  });

  it('resets the daily budget debounce window when another write arrives later', async () => {
    vi.useFakeTimers();
    const settingsStore: Record<string, unknown> = {
      [DAILY_BUDGET_KWH]: 40,
      [DAILY_BUDGET_ENABLED]: false,
    };
    const deps = buildDeps();
    deps.homey.settings.get = vi.fn((key: string) => settingsStore[key]);
    const handler = createSettingsHandler(deps);

    await handler(DAILY_BUDGET_KWH);
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    settingsStore[DAILY_BUDGET_ENABLED] = true;
    await handler(DAILY_BUDGET_ENABLED);

    await vi.advanceTimersByTimeAsync(199);
    await flushMicrotasks();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    expect(deps.loadDailyBudgetSettings).toHaveBeenCalledTimes(1);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('reruns daily budget sync once after in-flight writes finish', async () => {
    vi.useFakeTimers();
    let resolveFirstRebuild: (() => void) | null = null;
    const firstRebuildPromise = new Promise<void>((resolve) => {
      resolveFirstRebuild = resolve;
    });
    const settingsStore: Record<string, unknown> = {
      [DAILY_BUDGET_KWH]: 40,
    };
    const deps = buildDeps({
      rebuildPlanFromCache: vi.fn()
        .mockImplementationOnce(() => firstRebuildPromise)
        .mockResolvedValue(undefined),
    });
    deps.homey.settings.get = vi.fn((key: string) => settingsStore[key]);
    const handler = createSettingsHandler(deps);

    const first = handler(DAILY_BUDGET_KWH);
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(deps.loadDailyBudgetSettings).toHaveBeenCalledTimes(1);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    settingsStore[DAILY_BUDGET_KWH] = 45;
    const second = handler(DAILY_BUDGET_KWH);
    await flushMicrotasks();
    await Promise.all([first, second]);

    expect(deps.loadDailyBudgetSettings).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    resolveFirstRebuild?.();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(deps.loadDailyBudgetSettings).toHaveBeenCalledTimes(2);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(2);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect((deps.rebuildPlanFromCache as vi.Mock).mock.calls[1]?.[0]).toBe('settings:daily_budget_settings');
  });

  it('cancels pending debounced daily budget syncs on stop', async () => {
    vi.useFakeTimers();
    const settingsStore: Record<string, unknown> = {
      [DAILY_BUDGET_KWH]: 40,
    };
    const deps = buildDeps();
    deps.homey.settings.get = vi.fn((key: string) => settingsStore[key]);
    const handler = createSettingsHandler(deps);

    await handler(DAILY_BUDGET_KWH);
    handler.stop();

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();

    expect(deps.loadDailyBudgetSettings).not.toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).not.toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('refreshes managed devices and rebuilds', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(MANAGED_DEVICES);

    expect(deps.loadCapacitySettings).toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('refreshes budget exempt devices, updates daily budget state, and rebuilds', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(BUDGET_EXEMPT_DEVICES);

    expect(deps.loadCapacitySettings).toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith(`settings:${BUDGET_EXEMPT_DEVICES}`);
  });

  it('refreshes snapshot, restarts poll, and rebuilds plan when power source changes', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('power_source');

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Power source changed'));
    expect(deps.restartHomeyEnergyPoll).toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith('settings:power_source');
  });

  it('resets daily budget learning and clears the reset flag', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(DAILY_BUDGET_RESET);

    expect(deps.resetDailyBudgetLearning).toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(deps.homey.settings.set).toHaveBeenCalledWith(DAILY_BUDGET_RESET, null);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });
});
