import type { Mock } from 'vitest';
import { createSettingsHandler, type SettingsHandlerDeps } from '../../lib/utils/settingsHandlers';
import { createTemperatureControlFencedActuator } from '../../setup/appInit/buildDeviceActuator';
import {
  BUDGET_EXEMPT_DEVICES,
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  COMBINED_PRICES,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
  DAILY_BUDGET_RESET,
  DEBUG_LOGGING_TOPICS,
  DEVICE_COMMUNICATION_MODELS,
  DEVICE_EXPECTED_POWER_OVERRIDES,
  DEVICE_HOME_ASSIGNMENTS,
  DEVICE_DRIVER_OVERRIDES,
  DEVICE_TARGET_POWER_CONFIGS,
  HOMEY_ENERGY_METER_DEVICE_ID,
  HOMES_CONFIG,
  MANAGED_DEVICES,
  OVERSHOOT_BEHAVIORS,
  POWER_TRACKER_STATE,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
  WEATHER_ADVISOR_SETTINGS,
} from '../../lib/utils/settingsKeys';

const {
  settingsLoggerDebug, settingsLoggerInfo, settingsLoggerWarn, settingsLoggerError,
} = vi.hoisted(() => ({
  settingsLoggerDebug: vi.fn(),
  settingsLoggerInfo: vi.fn(),
  settingsLoggerWarn: vi.fn(),
  settingsLoggerError: vi.fn(),
}));

vi.mock('../../lib/logging/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/logging/logger')>();
  return {
    ...actual,
    getLogger: (component: string) => (
      component === 'settings'
        ? {
          debug: settingsLoggerDebug,
          info: settingsLoggerInfo,
          warn: settingsLoggerWarn,
          error: settingsLoggerError,
        }
        : actual.getLogger(component)
    ),
  };
});

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const expectedForcedDailyBudgetPersist = { forcePlanRebuild: true, persistReason: 'manual' };

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
    reloadExpectedPowerOverrides: vi.fn(),
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
    restartHomeyEnergyPoll: vi.fn(),
    stopFlowPowerSampleFreshnessClock: vi.fn(),
    syncFlowPowerSampleFreshnessClock: vi.fn(),
    ...overrides,
  };
};

describe('createSettingsHandler', () => {
  beforeEach(() => {
    settingsLoggerDebug.mockClear();
    settingsLoggerInfo.mockClear();
    settingsLoggerWarn.mockClear();
    settingsLoggerError.mockClear();
  });

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

  it('fans an overshoot behavior update out to sub-home plans', async () => {
    const rebuildHomeRuntimePlansForModeChange = vi.fn();
    const deps = buildDeps({ rebuildHomeRuntimePlansForModeChange });
    const handler = createSettingsHandler(deps);

    await handler(OVERSHOOT_BEHAVIORS);

    expect(deps.loadCapacitySettings).toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith(`settings:${OVERSHOOT_BEHAVIORS}`);
    expect(rebuildHomeRuntimePlansForModeChange).toHaveBeenCalledTimes(1);
  });

  it('refreshes all plan views when temperature control is disabled for a device', async () => {
    const rebuildAllHomeRuntimePlansForDeviceControlChange = vi.fn();
    const deps = buildDeps({ rebuildAllHomeRuntimePlansForDeviceControlChange });
    const handler = createSettingsHandler(deps);

    await handler(TEMPERATURE_CONTROL_DISABLED_DEVICES);

    expect(deps.loadCapacitySettings).toHaveBeenCalledTimes(1);
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith(
      `settings:${TEMPERATURE_CONTROL_DISABLED_DEVICES}`,
    );
    expect(rebuildAllHomeRuntimePlansForDeviceControlChange).toHaveBeenCalledTimes(1);
  });

  it('fans an expected-power override out to sub-home plans, after re-reading it', async () => {
    // The map is keyed on device, not on meter area, so a device living in an
    // initialized sub-home is replanned only by that home's runtime.
    const rebuildAllHomeRuntimePlansForDeviceControlChange = vi.fn();
    const deps = buildDeps({ rebuildAllHomeRuntimePlansForDeviceControlChange });
    const handler = createSettingsHandler(deps);

    await handler(DEVICE_EXPECTED_POWER_OVERRIDES);

    expect(deps.reloadExpectedPowerOverrides).toHaveBeenCalledTimes(1);
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith(
      `settings:${DEVICE_EXPECTED_POWER_OVERRIDES}`,
    );
    expect(rebuildAllHomeRuntimePlansForDeviceControlChange).toHaveBeenCalledTimes(1);
  });

  it('publishes the temperature command fence before a parked settings queue drains', async () => {
    let releaseRefresh: (() => void) | undefined;
    const parkedRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let temperatureControlDisabled = false;
    const deps = buildDeps({
      refreshTargetDevicesSnapshot: vi.fn(() => parkedRefresh),
      onTemperatureControlPolicyObserved: vi.fn(() => { temperatureControlDisabled = true; }),
    });
    const handler = createSettingsHandler(deps);
    const parkedWrite = handler(DEVICE_DRIVER_OVERRIDES);
    await flushMicrotasks();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);

    const apply = vi.fn(async () => ({ requested: true as const }));
    const actuator = createTemperatureControlFencedActuator(
      { apply },
      () => temperatureControlDisabled,
    );
    const temperatureToggle = handler(TEMPERATURE_CONTROL_DISABLED_DEVICES);

    expect(deps.onTemperatureControlPolicyObserved).toHaveBeenCalledTimes(1);
    await expect(actuator.apply({
      kind: 'target', deviceId: 'thermostat', capabilityId: 'target_temperature', value: 18,
    })).resolves.toEqual({ requested: false });
    await expect(actuator.apply({
      kind: 'step',
      deviceId: 'thermostat',
      profile: { model: 'stepped_load', steps: [{ id: 'off', planningPowerW: 0 }] },
      desiredStepId: 'off',
      planningPowerW: 0,
      planningCurrentA: 0,
    })).resolves.toEqual({ requested: false });
    expect(apply).not.toHaveBeenCalled();

    releaseRefresh?.();
    await Promise.all([parkedWrite, temperatureToggle]);
  });

  it('logs and still rebuilds if mode target refresh fails', async () => {
    const deps = buildDeps({
      refreshTargetDevicesSnapshot: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const handler = createSettingsHandler(deps);

    await handler('mode_device_targets');

    expect(settingsLoggerError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'mode_targets_snapshot_refresh_failed',
    }));
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
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith(expectedForcedDailyBudgetPersist);
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

  it('reloads capacity settings, refreshes snapshot, and rebuilds when target power configs change', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(DEVICE_TARGET_POWER_CONFIGS);

    expect(deps.loadCapacitySettings).toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith(`settings:${DEVICE_TARGET_POWER_CONFIGS}`);
  });

  it('logs when a refresh snapshot fails', async () => {
    const deps = buildDeps({
      refreshTargetDevicesSnapshot: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const handler = createSettingsHandler(deps);

    await handler('refresh_target_devices_snapshot');

    expect(settingsLoggerError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'settings_snapshot_refresh_failed',
      reasonCode: 'manual_snapshot_refresh',
    }));
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

    expect(settingsLoggerError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'grid_tariff_refresh_failed',
    }));
  });

  it('routes settings UI log entries by level', async () => {
    const deps = buildDeps();
    deps.homey.settings.get = vi.fn()
      .mockReturnValueOnce({ level: 'error', message: 'Bad', detail: 'Detail', context: 'Form' })
      .mockReturnValueOnce({ level: 'warn', message: 'Heads up' })
      .mockReturnValueOnce({ level: 'info', message: 'Ok', detail: 'Done' });
    const handler = createSettingsHandler(deps);

    await handler('settings_ui_log');
    await handler('settings_ui_log');
    await handler('settings_ui_log');

    expect(settingsLoggerError).toHaveBeenCalledTimes(1);
    expect(settingsLoggerError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'settings_ui_log',
      level: 'error',
      message: 'Bad',
      detail: 'Detail',
      context: 'Form',
    }));
    expect(settingsLoggerWarn).toHaveBeenCalledTimes(1);
    expect(settingsLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'settings_ui_log',
      level: 'warn',
      message: 'Heads up',
    }));
    expect(settingsLoggerInfo).toHaveBeenCalledTimes(1);
    expect(settingsLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({
      event: 'settings_ui_log',
      level: 'info',
      message: 'Ok',
      detail: 'Done',
    }));
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

    expect(settingsLoggerInfo).not.toHaveBeenCalled();
    expect(settingsLoggerWarn).not.toHaveBeenCalled();
    expect(settingsLoggerError).not.toHaveBeenCalled();
    expect(deps.homey.settings.set).not.toHaveBeenCalled();
  });

  it('logs handler failures and continues', async () => {
    const deps = buildDeps({
      rebuildPlanFromCache: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const handler = createSettingsHandler(deps);

    await handler('capacity_priorities');

    expect(settingsLoggerError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'settings_handler_failed',
      settingKey: 'capacity_priorities',
    }));
  });

  it('handles debug logging toggle keys', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('debug_logging_enabled');
    await handler(DEBUG_LOGGING_TOPICS);

    expect(deps.updateDebugLoggingEnabled).toHaveBeenCalledTimes(2);
  });

  it('reloads the weather collector when its settings blob changes', async () => {
    const reloadWeatherAdvisor = vi.fn();
    const deps = buildDeps({ reloadWeatherAdvisor });
    const handler = createSettingsHandler(deps);

    await handler(WEATHER_ADVISOR_SETTINGS);

    expect(reloadWeatherAdvisor).toHaveBeenCalledTimes(1);
  });

  it('recomputes combined prices when price threshold changes', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('price_threshold_percent');

    expect(deps.priceService.updateCombinedPrices).toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith(expectedForcedDailyBudgetPersist);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('recomputes combined prices when minimum price difference changes', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('price_min_diff_ore');

    expect(deps.priceService.updateCombinedPrices).toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith(expectedForcedDailyBudgetPersist);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('recomputes combined prices when an export-price setting changes', async () => {
    const enabledDeps = buildDeps();
    await createSettingsHandler(enabledDeps)('export_price_enabled');
    expect(enabledDeps.priceService.updateCombinedPrices).toHaveBeenCalled();
    expect(enabledDeps.rebuildPlanFromCache).toHaveBeenCalled();

    const factorDeps = buildDeps();
    await createSettingsHandler(factorDeps)('export_spot_factor');
    expect(factorDeps.priceService.updateCombinedPrices).toHaveBeenCalled();

    const fixedDeps = buildDeps();
    await createSettingsHandler(fixedDeps)('export_fixed');
    expect(fixedDeps.priceService.updateCombinedPrices).toHaveBeenCalled();
  });

  it('recomputes combined prices when provider surcharge changes', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('provider_surcharge');

    expect(deps.priceService.updateCombinedPrices).toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith(expectedForcedDailyBudgetPersist);
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
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith(expectedForcedDailyBudgetPersist);
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

    (resolveFirstRebuild as (() => void) | null)?.();
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
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith(expectedForcedDailyBudgetPersist);
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

    (resolveFirstRebuild as (() => void) | null)?.();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(deps.loadDailyBudgetSettings).toHaveBeenCalledTimes(2);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledTimes(2);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect((deps.rebuildPlanFromCache as Mock).mock.calls[1]?.[0]).toBe('settings:daily_budget_settings');
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
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith(expectedForcedDailyBudgetPersist);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith(`settings:${BUDGET_EXEMPT_DEVICES}`);
  });

  it('refreshes snapshot, restarts poll, and rebuilds plan when power source changes', async () => {
    const order: string[] = [];
    const reloadWeatherAdvisor = vi.fn();
    const deps = buildDeps({
      onHomeRuntimePowerSourceChanged: vi.fn(() => { order.push('home-runtime'); }),
      restartHomeyEnergyPoll: vi.fn(() => { order.push('poll'); }),
      reloadWeatherAdvisor,
    });
    const handler = createSettingsHandler(deps);

    await handler('power_source');

    expect(settingsLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({ event: 'power_source_changed' }));
    expect(deps.onHomeRuntimePowerSourceChanged).toHaveBeenCalled();
    expect(deps.restartHomeyEnergyPoll).toHaveBeenCalled();
    expect(order).toEqual(['home-runtime', 'poll']);
    expect(deps.stopFlowPowerSampleFreshnessClock).toHaveBeenCalled();
    expect(deps.syncFlowPowerSampleFreshnessClock).toHaveBeenCalled();
    // The source is part of the weather meter-scope fingerprint: the switch
    // must hit the collector's restart edge so its reconcile can invalidate.
    expect(reloadWeatherAdvisor).toHaveBeenCalledTimes(1);
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith('settings:power_source');
  });

  it('restarts the poll and rebuilds the plan when the whole-home meter changes', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler('homey_energy_meter_device_id');

    expect(settingsLoggerInfo).toHaveBeenCalledWith(expect.objectContaining({ event: 'homey_energy_meter_changed' }));
    expect(deps.restartHomeyEnergyPoll).toHaveBeenCalled();
    // Unlike a power-source change, the flow freshness clock and snapshot are
    // untouched — the source itself did not change.
    expect(deps.stopFlowPowerSampleFreshnessClock).not.toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).not.toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledWith('settings:homey_energy_meter');
  });

  it('invalidates an old-meter poll before a queued settings handler can restart it', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const onHomeyEnergyMeterObserved = vi.fn();
    const onMainMeterSelectionObserved = vi.fn();
    const onHomeOwnershipConfigurationObserved = vi.fn();
    const deps = buildDeps({
      refreshTargetDevicesSnapshot: vi.fn(() => refreshBlocked),
      onHomeyEnergyMeterObserved,
      onMainMeterSelectionObserved,
      onHomeOwnershipConfigurationObserved,
    });
    const handler = createSettingsHandler(deps);

    const prior = handler(MANAGED_DEVICES);
    await flushMicrotasks();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();

    const meterChange = handler(HOMEY_ENERGY_METER_DEVICE_ID);
    // Both safety edges run synchronously, before the serialized handler can
    // reach restart/rebuild behind the blocked managed-devices refresh.
    expect(onHomeyEnergyMeterObserved).toHaveBeenCalledOnce();
    expect(onMainMeterSelectionObserved).toHaveBeenCalledOnce();
    expect(deps.restartHomeyEnergyPoll).not.toHaveBeenCalled();
    const areaChange = handler(HOMES_CONFIG);
    const assignmentsChange = handler(DEVICE_HOME_ASSIGNMENTS);
    expect(onMainMeterSelectionObserved).toHaveBeenCalledOnce();
    expect(onHomeOwnershipConfigurationObserved).toHaveBeenCalledTimes(2);

    releaseRefresh?.();
    await Promise.all([prior, meterChange, areaChange, assignmentsChange]);
    expect(deps.restartHomeyEnergyPoll).toHaveBeenCalledOnce();
  });

  it('resets daily budget learning and clears the reset flag', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(DAILY_BUDGET_RESET);

    expect(deps.resetDailyBudgetLearning).toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith(expectedForcedDailyBudgetPersist);
    expect(deps.homey.settings.set).toHaveBeenCalledWith(DAILY_BUDGET_RESET, null);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('routes a home-suffixed capacity write to the hook, not the main handlers', async () => {
    const onHomeScopedSettingChanged = vi.fn();
    const deps = buildDeps({ onHomeScopedSettingChanged });
    const handler = createSettingsHandler(deps);

    await handler(`${CAPACITY_LIMIT_KW}:cabin`);

    expect(onHomeScopedSettingChanged).toHaveBeenCalledTimes(1);
    expect(onHomeScopedSettingChanged).toHaveBeenCalledWith(CAPACITY_LIMIT_KW, 'cabin');
    expect(deps.loadCapacitySettings).not.toHaveBeenCalled();
    expect(deps.updateOverheadToken).not.toHaveBeenCalled();
    expect(deps.updateDailyBudgetState).not.toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('routes a home-suffixed tracker write to the hook and never reloads the main tracker', async () => {
    const onHomeScopedSettingChanged = vi.fn();
    const deps = buildDeps({ onHomeScopedSettingChanged });
    const handler = createSettingsHandler(deps);

    await handler(`${POWER_TRACKER_STATE}:cabin`);

    expect(onHomeScopedSettingChanged).toHaveBeenCalledWith(POWER_TRACKER_STATE, 'cabin');
    expect(deps.loadPowerTracker).not.toHaveBeenCalled();
  });

  it('ignores home-suffixed writes when no hook is wired', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(`${POWER_TRACKER_STATE}:cabin`);

    expect(deps.loadPowerTracker).not.toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();
    expect(settingsLoggerError).not.toHaveBeenCalled();
  });

  it('dispatches a colon key with a non-scopable base as an ordinary exact key', async () => {
    const onHomeScopedSettingChanged = vi.fn();
    const deps = buildDeps({ onHomeScopedSettingChanged });
    const handler = createSettingsHandler(deps);

    // No handler is registered for `foo:bar`, so an exact-key dispatch ignores
    // it — the hook must not fire for a base outside the home-scopable set.
    await handler('foo:bar');

    expect(onHomeScopedSettingChanged).not.toHaveBeenCalled();
    expect(deps.loadCapacitySettings).not.toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).not.toHaveBeenCalled();
  });

  it('keeps unsuffixed dispatch and dedupe unchanged when the hook is wired', async () => {
    const onHomeScopedSettingChanged = vi.fn();
    const deps = buildDeps({ onHomeScopedSettingChanged });
    deps.homey.settings.get = vi.fn().mockReturnValue(25);
    const handler = createSettingsHandler(deps);

    await handler('price_threshold_percent');
    await handler('price_threshold_percent');

    expect(deps.priceService.updateCombinedPrices).toHaveBeenCalledTimes(1);
    expect(onHomeScopedSettingChanged).not.toHaveBeenCalled();
  });

  it('logs and keeps dispatching when the home-scoped hook throws', async () => {
    const onHomeScopedSettingChanged = vi.fn(() => {
      throw new Error('hook fail');
    });
    const deps = buildDeps({ onHomeScopedSettingChanged });
    const handler = createSettingsHandler(deps);

    await handler(`${CAPACITY_DRY_RUN}:cabin`);
    await handler(MANAGED_DEVICES);

    expect(settingsLoggerError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_scoped_settings_hook_failed',
      settingKey: `${CAPACITY_DRY_RUN}:cabin`,
    }));
    expect(deps.loadCapacitySettings).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('contains a rejecting async hook: logged, dispatch continues, no unhandled rejection', async () => {
    const onHomeScopedSettingChanged = vi.fn(async () => {
      throw new Error('async hook fail');
    });
    const deps = buildDeps({ onHomeScopedSettingChanged });
    const handler = createSettingsHandler(deps);

    // Mirrors the settings `set` listener seam: the awaited handle must
    // resolve (not reject) even though the hook's promise rejects.
    await expect(handler(`${POWER_TRACKER_STATE}:cabin`)).resolves.toBeUndefined();
    await handler(MANAGED_DEVICES);

    expect(settingsLoggerError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_scoped_settings_hook_failed',
      settingKey: `${POWER_TRACKER_STATE}:cabin`,
    }));
    expect(deps.loadPowerTracker).not.toHaveBeenCalled();
    expect(deps.loadCapacitySettings).toHaveBeenCalledTimes(1);
    expect(deps.rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('debug-logs a scopable base with a malformed home suffix before exact dispatch', async () => {
    const onHomeScopedSettingChanged = vi.fn();
    const deps = buildDeps({ onHomeScopedSettingChanged });
    const handler = createSettingsHandler(deps);

    // Empty suffix and explicit `:main` both parse back to ordinary exact
    // keys (no registered handler → ignored) but leave a diagnosable trace.
    await handler(`${CAPACITY_LIMIT_KW}:`);
    await handler(`${CAPACITY_LIMIT_KW}:main`);

    expect(settingsLoggerDebug).toHaveBeenCalledTimes(2);
    expect(settingsLoggerDebug).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event: 'home_scoped_settings_key_malformed',
      settingKey: `${CAPACITY_LIMIT_KW}:`,
    }));
    expect(settingsLoggerDebug).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event: 'home_scoped_settings_key_malformed',
      settingKey: `${CAPACITY_LIMIT_KW}:main`,
    }));
    expect(onHomeScopedSettingChanged).not.toHaveBeenCalled();
    expect(deps.loadCapacitySettings).not.toHaveBeenCalled();

    // Non-scopable colon keys and plain unsuffixed keys stay silent.
    settingsLoggerDebug.mockClear();
    await handler('foo:bar');
    await handler(MANAGED_DEVICES);
    expect(settingsLoggerDebug).not.toHaveBeenCalled();
  });
});
