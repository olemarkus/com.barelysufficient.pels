import {
  buildSettingsUiBootstrap,
  getSettingsUiDeviceDiagnosticsPayload,
  getSettingsUiDevicesPayload,
  getSettingsUiPlanPayload,
  getSettingsUiPowerPayload,
  getSettingsUiPricesPayload,
  logSettingsUiMessage,
  refreshSettingsUiDevices,
  refreshSettingsUiGridTariff,
  refreshSettingsUiPrices,
  resetSettingsUiPowerStats,
} from '../lib/app/settingsUiApi';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../lib/utils/settingsUiBootstrapKeys';

describe('settingsUiApi', () => {
  const createHomey = (options: { latestPlanSnapshot?: Record<string, unknown> | null } = {}) => {
    const store = new Map<string, unknown>([
      ['target_devices_snapshot', [{ id: 'dev-1', name: 'Heater' }]],
      ['device_plan_snapshot', { devices: [{ id: 'dev-1', name: 'Heater', priority: 1 }] }],
      ['combined_prices', { prices: [{ startsAt: '2026-03-03T00:00:00.000Z', total: 10 }] }],
      ['power_tracker_state', { buckets: { '2026-03-03T00:00:00.000Z': 1.2 } }],
      ['pels_status', { lastPowerUpdate: 123, priceLevel: 'cheap' }],
      ['app_heartbeat', 456],
      ['homey_prices_currency', 'NOK'],
      ['homey_prices_today', { dateKey: '2026-03-03', pricesByHour: { '0': 1 }, updatedAt: '2026-03-03T00:00:00.000Z' }],
      ['homey_prices_tomorrow', { dateKey: '2026-03-04', pricesByHour: { '0': 2 }, updatedAt: '2026-03-03T12:00:00.000Z' }],
      ['flow_prices_today', { dateKey: '2026-03-03', pricesByHour: { '0': 1 }, updatedAt: '2026-03-03T00:00:00.000Z' }],
      ['flow_prices_tomorrow', { dateKey: '2026-03-04', pricesByHour: { '0': 2 }, updatedAt: '2026-03-03T12:00:00.000Z' }],
      ['nettleie_data', [{ dateKey: '2026-03-03', energyFeeIncVat: 0.5 }]],
      ['price_area', 'NO1'],
    ]);

    const log = vi.fn();
    const error = vi.fn();
    let latestDevices = [{ id: 'dev-1', name: 'Heater' }];
    let powerTracker: Record<string, unknown> = { buckets: { '2026-03-03T00:00:00.000Z': 1.2 } };
    const refreshTargetDevicesSnapshot = vi.fn().mockImplementation(async () => {
      latestDevices = [{ id: 'dev-2', name: 'Pump' }];
    });
    const refreshSpotPrices = vi.fn().mockResolvedValue(undefined);
    const refreshGridTariffData = vi.fn().mockResolvedValue(undefined);
    const updateDailyBudgetAndRecordCap = vi.fn();
    const persistPowerTrackerState = vi.fn();
    const replacePowerTrackerForUi = vi.fn().mockImplementation((nextState: Record<string, unknown>) => {
      powerTracker = nextState;
      updateDailyBudgetAndRecordCap({
        nowMs: Date.now(),
        forcePlanRebuild: true,
      });
      persistPowerTrackerState();
    });
    const getDailyBudgetUiPayload = vi.fn().mockReturnValue({ days: {}, todayKey: '2026-03-03' });
    const getDeviceDiagnosticsUiPayload = vi.fn().mockReturnValue({
      generatedAt: 123456,
      windowDays: 21,
      diagnosticsByDeviceId: {
        'dev-1': {
          currentPenaltyLevel: 2,
          windows: {
            '1d': {
              unmetDemandMs: 1,
              blockedByHeadroomMs: 1,
              blockedByCooldownBackoffMs: 0,
              targetDeficitMs: 1,
              shedCount: 0,
              restoreCount: 0,
              failedActivationCount: 0,
              stableActivationCount: 0,
              penaltyBumpCount: 0,
              maxPenaltyLevelSeen: 2,
              avgShedToRestoreMs: null,
              avgRestoreToSetbackMs: null,
              minRestoreToSetbackMs: null,
              maxRestoreToSetbackMs: null,
            },
            '7d': {
              unmetDemandMs: 1,
              blockedByHeadroomMs: 1,
              blockedByCooldownBackoffMs: 0,
              targetDeficitMs: 1,
              shedCount: 0,
              restoreCount: 0,
              failedActivationCount: 0,
              stableActivationCount: 0,
              penaltyBumpCount: 0,
              maxPenaltyLevelSeen: 2,
              avgShedToRestoreMs: null,
              avgRestoreToSetbackMs: null,
              minRestoreToSetbackMs: null,
              maxRestoreToSetbackMs: null,
            },
            '21d': {
              unmetDemandMs: 1,
              blockedByHeadroomMs: 1,
              blockedByCooldownBackoffMs: 0,
              targetDeficitMs: 1,
              shedCount: 0,
              restoreCount: 0,
              failedActivationCount: 0,
              stableActivationCount: 0,
              penaltyBumpCount: 0,
              maxPenaltyLevelSeen: 2,
              avgShedToRestoreMs: null,
              avgRestoreToSetbackMs: null,
              minRestoreToSetbackMs: null,
              maxRestoreToSetbackMs: null,
            },
          },
        },
      },
    });
    const app = {
      log,
      error,
      refreshTargetDevicesSnapshot,
      priceCoordinator: {
        refreshSpotPrices,
        refreshGridTariffData,
      },
      replacePowerTrackerForUi,
      getDailyBudgetUiPayload,
      getDeviceDiagnosticsUiPayload,
      get latestTargetSnapshot() {
        return latestDevices;
      },
      get powerTracker() {
        return powerTracker;
      },
      set powerTracker(value: Record<string, unknown>) {
        powerTracker = value;
      },
    };
    if (Object.prototype.hasOwnProperty.call(options, 'latestPlanSnapshot')) {
      (app as typeof app & { getLatestPlanSnapshotForUi?: () => Record<string, unknown> | null }).getLatestPlanSnapshotForUi = () => (
        options.latestPlanSnapshot ?? null
      );
    }

    return {
      settings: {
        get: (key: string) => store.get(key),
      },
      app,
      log,
      error,
      refreshTargetDevicesSnapshot,
      refreshSpotPrices,
      refreshGridTariffData,
      replacePowerTrackerForUi,
      updateDailyBudgetAndRecordCap,
      persistPowerTrackerState,
      getDailyBudgetUiPayload,
      getDeviceDiagnosticsUiPayload,
    };
  };

  it('builds bootstrap payload from current settings and daily budget data', () => {
    const homey = createHomey();

    const result = buildSettingsUiBootstrap({ homey: homey as never });

    expect(Object.keys(result.settings)).toEqual([...SETTINGS_UI_BOOTSTRAP_KEYS]);
    expect(result.settings.target_devices_snapshot).toBeUndefined();
    expect(result.settings.combined_prices).toBeUndefined();
    expect(result.dailyBudget).toEqual({ days: {}, todayKey: '2026-03-03' });
    expect((result as unknown as Record<string, unknown>).devices).toBeUndefined();
    expect(result.plan).toEqual({ devices: [{ id: 'dev-1', name: 'Heater', priority: 1, reason: { code: 'none' } }] });
    expect(result.power).toEqual({
      tracker: { buckets: { '2026-03-03T00:00:00.000Z': 1.2 } },
      status: { lastPowerUpdate: 123, priceLevel: 'cheap' },
      heartbeat: 456,
    });
    expect(result.prices.combinedPrices).toEqual({ prices: [{ startsAt: '2026-03-03T00:00:00.000Z', total: 10 }] });
    expect(result.prices.homeyCurrency).toBe('NOK');
  });

  it('returns refreshed devices from the app wrapper', async () => {
    const homey = createHomey();

    const result = await refreshSettingsUiDevices({ homey: homey as never });

    expect(homey.refreshTargetDevicesSnapshot).toHaveBeenCalledTimes(1);
    expect(result.devices).toEqual([{ id: 'dev-2', name: 'Pump' }]);
  });

  it('returns refreshed prices from the app wrapper', async () => {
    const homey = createHomey();

    const result = await refreshSettingsUiPrices({ homey: homey as never });

    expect(homey.refreshSpotPrices).toHaveBeenCalledWith(true);
    expect(result.combinedPrices).toEqual({ prices: [{ startsAt: '2026-03-03T00:00:00.000Z', total: 10 }] });
  });

  it('returns refreshed grid tariff data from the app wrapper', async () => {
    const homey = createHomey();

    const result = await refreshSettingsUiGridTariff({ homey: homey as never });

    expect(homey.refreshGridTariffData).toHaveBeenCalledWith(true);
    expect(result.gridTariffData).toEqual([{ dateKey: '2026-03-03', energyFeeIncVat: 0.5 }]);
  });

  it('returns reset power state and refreshed daily budget payload', async () => {
    const homey = createHomey();

    const result = await resetSettingsUiPowerStats({ homey: homey as never });

    expect(homey.updateDailyBudgetAndRecordCap).toHaveBeenCalledWith({
      nowMs: expect.any(Number),
      forcePlanRebuild: true,
    });
    expect(homey.persistPowerTrackerState).toHaveBeenCalledTimes(1);
    expect(result.power.tracker).toEqual({
      buckets: {},
      controlledBuckets: {},
      controlledDailyTotals: {},
      controlledHourlyAverages: {},
      exemptBuckets: {},
      exemptDailyTotals: {},
      exemptHourlyAverages: {},
      uncontrolledBuckets: {},
      uncontrolledDailyTotals: {},
      uncontrolledHourlyAverages: {},
      hourlySampleCounts: {},
      hourlyBudgets: {},
      dailyBudgetCaps: {},
      dailyTotals: {},
      hourlyAverages: {},
      unreliablePeriods: [],
    });
    expect(result.dailyBudget).toEqual({ days: {}, todayKey: '2026-03-03' });
  });

  it('builds dedicated read payloads for the remaining volatile UI models', () => {
    const homey = createHomey();

    expect(getSettingsUiDevicesPayload({ homey: homey as never })).toEqual({
      devices: [{ id: 'dev-1', name: 'Heater' }],
    });
    expect(getSettingsUiPlanPayload({ homey: homey as never })).toEqual({
      plan: { devices: [{ id: 'dev-1', name: 'Heater', priority: 1, reason: { code: 'none' } }] },
    });
    expect(getSettingsUiPowerPayload({ homey: homey as never })).toEqual({
      tracker: { buckets: { '2026-03-03T00:00:00.000Z': 1.2 } },
      status: { lastPowerUpdate: 123, priceLevel: 'cheap' },
      heartbeat: 456,
    });
    expect(getSettingsUiPricesPayload({ homey: homey as never })).toEqual({
      combinedPrices: { prices: [{ startsAt: '2026-03-03T00:00:00.000Z', total: 10 }] },
      electricityPrices: null,
      priceArea: 'NO1',
      gridTariffData: [{ dateKey: '2026-03-03', energyFeeIncVat: 0.5 }],
      flowToday: { dateKey: '2026-03-03', pricesByHour: { '0': 1 }, updatedAt: '2026-03-03T00:00:00.000Z' },
      flowTomorrow: { dateKey: '2026-03-04', pricesByHour: { '0': 2 }, updatedAt: '2026-03-03T12:00:00.000Z' },
      homeyCurrency: 'NOK',
      homeyToday: { dateKey: '2026-03-03', pricesByHour: { '0': 1 }, updatedAt: '2026-03-03T00:00:00.000Z' },
      homeyTomorrow: { dateKey: '2026-03-04', pricesByHour: { '0': 2 }, updatedAt: '2026-03-03T12:00:00.000Z' },
    });
    expect(getSettingsUiDeviceDiagnosticsPayload({ homey: homey as never })).toEqual({
      generatedAt: 123456,
      windowDays: 21,
      diagnosticsByDeviceId: expect.objectContaining({
        'dev-1': expect.objectContaining({ currentPenaltyLevel: 2 }),
      }),
    });
  });

  it('returns an empty diagnostics payload when the app has no diagnostics API yet', () => {
    const homey = createHomey();
    delete (homey.app as { getDeviceDiagnosticsUiPayload?: unknown }).getDeviceDiagnosticsUiPayload;

    expect(getSettingsUiDeviceDiagnosticsPayload({ homey: homey as never })).toEqual({
      generatedAt: expect.any(Number),
      windowDays: 21,
      diagnosticsByDeviceId: {},
    });
  });

  it('returns an empty diagnostics payload when the diagnostics API throws', () => {
    const homey = createHomey();
    homey.getDeviceDiagnosticsUiPayload.mockImplementation(() => {
      throw new Error('diagnostics not ready');
    });

    expect(getSettingsUiDeviceDiagnosticsPayload({ homey: homey as never })).toEqual({
      generatedAt: expect.any(Number),
      windowDays: 21,
      diagnosticsByDeviceId: {},
    });
    expect(homey.error).toHaveBeenCalledWith('Device diagnostics API failed', expect.any(Error));
  });

  it('prefers the live in-memory plan snapshot over the persisted settings snapshot', () => {
    const homey = createHomey({
      latestPlanSnapshot: {
        generatedAtMs: 123456789,
        devices: [{ id: 'dev-2', name: 'Pump', priority: 2 }],
      },
    });

    expect(buildSettingsUiBootstrap({ homey: homey as never }).plan).toEqual({
      generatedAtMs: 123456789,
      devices: [{ id: 'dev-2', name: 'Pump', priority: 2 }],
    });
    expect(getSettingsUiPlanPayload({ homey: homey as never })).toEqual({
      plan: {
        generatedAtMs: 123456789,
        devices: [{ id: 'dev-2', name: 'Pump', priority: 2 }],
      },
    });
  });

  it('throws when refresh or reset functionality is unavailable', async () => {
    const homey = createHomey();
    delete (homey.app as Partial<typeof homey.app>).refreshTargetDevicesSnapshot;
    delete (homey.app as Partial<typeof homey.app>).priceCoordinator;
    delete (homey.app as Partial<typeof homey.app>).replacePowerTrackerForUi;

    await expect(refreshSettingsUiDevices({ homey: homey as never })).rejects.toThrow(
      'Refresh devices functionality is not available in the app.',
    );
    await expect(refreshSettingsUiPrices({ homey: homey as never })).rejects.toThrow(
      'Refresh prices functionality is not available in the app.',
    );
    await expect(refreshSettingsUiGridTariff({ homey: homey as never })).rejects.toThrow(
      'Refresh grid tariff functionality is not available in the app.',
    );
    await expect(resetSettingsUiPowerStats({ homey: homey as never })).rejects.toThrow(
      'Reset power stats functionality is not available in the app.',
    );
  });

  it('routes UI log entries to the correct app logger', () => {
    const homey = createHomey();

    logSettingsUiMessage({
      homey: homey as never,
      body: { level: 'warn', message: 'Something odd', context: 'boot', timestamp: Date.now() },
    });
    logSettingsUiMessage({
      homey: homey as never,
      body: { level: 'error', message: 'Boom', detail: 'Stack', timestamp: Date.now() },
    });

    expect(homey.log).toHaveBeenCalledWith('Warning: Settings UI (boot): Something odd');
    expect(homey.error).toHaveBeenCalledWith('Settings UI: Boom - Stack', expect.any(Error));
  });
});
