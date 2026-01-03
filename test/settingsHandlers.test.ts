import { createSettingsHandler, type SettingsHandlerDeps } from '../lib/utils/settingsHandlers';
import {
  CAPACITY_LIMIT_KW,
  DAILY_BUDGET_RESET,
  DEBUG_LOGGING_TOPICS,
  MANAGED_DEVICES,
} from '../lib/utils/settingsKeys';

const buildDeps = (overrides: Partial<SettingsHandlerDeps> = {}): SettingsHandlerDeps => {
  const homey = {
    settings: {
      get: jest.fn(),
      set: jest.fn(),
    },
  } as unknown as SettingsHandlerDeps['homey'];

  return {
    homey,
    loadCapacitySettings: jest.fn(),
    rebuildPlanFromCache: jest.fn().mockResolvedValue(undefined),
    refreshTargetDevicesSnapshot: jest.fn().mockResolvedValue(undefined),
    loadPowerTracker: jest.fn(),
    getCapacityGuard: jest.fn().mockReturnValue(undefined),
    getCapacitySettings: jest.fn().mockReturnValue({ limitKw: 10, marginKw: 1 }),
    getCapacityDryRun: jest.fn().mockReturnValue(false),
    loadPriceOptimizationSettings: jest.fn(),
    loadDailyBudgetSettings: jest.fn(),
    updateDailyBudgetState: jest.fn(),
    resetDailyBudgetLearning: jest.fn(),
    priceService: {
      refreshNettleieData: jest.fn().mockResolvedValue(undefined),
      refreshSpotPrices: jest.fn().mockResolvedValue(undefined),
    },
    updatePriceOptimizationEnabled: jest.fn(),
    updateOverheadToken: jest.fn().mockResolvedValue(undefined),
    updateDebugLoggingEnabled: jest.fn(),
    log: jest.fn(),
    errorLog: jest.fn(),
    ...overrides,
  };
};

describe('createSettingsHandler', () => {
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
      refreshTargetDevicesSnapshot: jest.fn().mockRejectedValue(new Error('fail')),
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
      setLimit: jest.fn(),
      setSoftMargin: jest.fn(),
    };
    const deps = buildDeps({
      getCapacityGuard: jest.fn().mockReturnValue(guard),
      getCapacitySettings: jest.fn().mockReturnValue({ limitKw: 12, marginKw: 0.5 }),
    });
    const handler = createSettingsHandler(deps);

    await handler(CAPACITY_LIMIT_KW);

    expect(guard.setLimit).toHaveBeenCalledWith(12);
    expect(guard.setSoftMargin).toHaveBeenCalledWith(0.5);
    expect(deps.updateOverheadToken).toHaveBeenCalledWith(0.5);
    expect(deps.updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
  });

  it('logs when a refresh snapshot fails', async () => {
    const deps = buildDeps({
      refreshTargetDevicesSnapshot: jest.fn().mockRejectedValue(new Error('fail')),
    });
    const handler = createSettingsHandler(deps);

    await handler('refresh_target_devices_snapshot');

    expect(deps.errorLog).toHaveBeenCalledWith(
      'Failed to refresh target devices snapshot',
      expect.any(Error),
    );
  });

  it('logs when nettleie refresh fails', async () => {
    const deps = buildDeps({
      priceService: {
        refreshNettleieData: jest.fn().mockRejectedValue(new Error('fail')),
        refreshSpotPrices: jest.fn().mockResolvedValue(undefined),
      },
    });
    const handler = createSettingsHandler(deps);

    await handler('refresh_nettleie');

    expect(deps.errorLog).toHaveBeenCalledWith('Failed to refresh nettleie data', expect.any(Error));
  });

  it('routes settings UI log entries by level', async () => {
    const errorLog = jest.fn() as jest.MockedFunction<SettingsHandlerDeps['errorLog']>;
    const deps = buildDeps({ errorLog });
    deps.homey.settings.get = jest.fn()
      .mockReturnValueOnce({ level: 'error', message: 'Bad', detail: 'Detail', context: 'Form' })
      .mockReturnValueOnce({ level: 'warn', message: 'Heads up' })
      .mockReturnValueOnce({ level: 'info', message: 'Ok', detail: 'Done' });
    const handler = createSettingsHandler(deps);

    await handler('settings_ui_log');
    await handler('settings_ui_log');
    await handler('settings_ui_log');

    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Settings UI'), expect.any(Error));
    const loggedError = errorLog.mock.calls[0][1] as Error;
    expect(loggedError.message).toBe('Detail');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Warning:'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Settings UI'));
    expect(deps.homey.settings.set).toHaveBeenCalledWith('settings_ui_log', null);
  });

  it('ignores invalid settings UI log payloads', async () => {
    const deps = buildDeps();
    deps.homey.settings.get = jest.fn()
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
      rebuildPlanFromCache: jest.fn().mockRejectedValue(new Error('fail')),
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

  it('refreshes managed devices and rebuilds', async () => {
    const deps = buildDeps();
    const handler = createSettingsHandler(deps);

    await handler(MANAGED_DEVICES);

    expect(deps.loadCapacitySettings).toHaveBeenCalled();
    expect(deps.refreshTargetDevicesSnapshot).toHaveBeenCalled();
    expect(deps.rebuildPlanFromCache).toHaveBeenCalled();
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
