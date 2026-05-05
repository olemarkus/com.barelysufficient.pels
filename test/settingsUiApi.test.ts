import { createHash } from 'node:crypto';
import {
  buildSettingsUiBootstrap,
  getSettingsUiDeviceDiagnosticsPayload,
  getSettingsUiDevicesPayload,
  getSettingsUiPlanPayload,
  getSettingsUiPowerPayload,
  getSettingsUiPricesPayload,
  logSettingsUiMessage,
  applySettingsUiDailyBudgetModel,
  previewSettingsUiDailyBudgetModel,
  refreshSettingsUiDevices,
  refreshSettingsUiGridTariff,
  refreshSettingsUiPrices,
  recomputeSettingsUiDailyBudget,
  resetSettingsUiPowerStats,
} from '../lib/app/settingsUiApi';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../packages/contracts/src/settingsUiApi';
import { buildComparablePlanReason } from '../packages/shared-domain/src/planReasonSemantics';

const hashHomeyIdForTest = (homeyId: string): string => (
  createHash('sha256').update(homeyId).digest('hex')
);

describe('settingsUiApi', () => {
  const createHomey = (
    options: {
      cloudHomeyId?: string;
      latestPlanSnapshot?: Record<string, unknown> | null;
      settings?: Record<string, unknown>;
    } = {},
  ) => {
    const store = new Map<string, unknown>([
      ['target_devices_snapshot', [{ id: 'dev-1', name: 'Heater' }]],
      ['combined_prices', { prices: [{ startsAt: '2026-03-03T00:00:00.000Z', total: 10 }] }],
      ['power_tracker_state', { buckets: { '2026-03-03T00:00:00.000Z': 1.2 } }],
      ['pels_status', { lastPowerUpdate: 123, priceLevel: 'cheap' }],
      ['homey_prices_currency', 'NOK'],
      ['homey_prices_today', { dateKey: '2026-03-03', pricesByHour: { '0': 1 }, updatedAt: '2026-03-03T00:00:00.000Z' }],
      ['homey_prices_tomorrow', { dateKey: '2026-03-04', pricesByHour: { '0': 2 }, updatedAt: '2026-03-03T12:00:00.000Z' }],
      ['flow_prices_today', { dateKey: '2026-03-03', pricesByHour: { '0': 1 }, updatedAt: '2026-03-03T00:00:00.000Z' }],
      ['flow_prices_tomorrow', { dateKey: '2026-03-04', pricesByHour: { '0': 2 }, updatedAt: '2026-03-03T12:00:00.000Z' }],
      ['nettleie_data', [{ dateKey: '2026-03-03', energyFeeIncVat: 0.5 }]],
      ['price_area', 'NO1'],
      ...Object.entries(options.settings ?? {}),
    ]);

    const log = vi.fn();
    const error = vi.fn();
    const defaultPlanSnapshot = {
      devices: [{ id: 'dev-1', name: 'Heater', priority: 1, reason: buildComparablePlanReason('keep') }],
    };
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
    const recomputeDailyBudgetToday = vi.fn().mockReturnValue({ days: {}, todayKey: '2026-03-03' });
    const previewDailyBudgetModel = vi.fn().mockImplementation((settings: Record<string, unknown>) => ({
      active: { days: {}, todayKey: '2026-03-03' },
      candidate: { days: {}, todayKey: '2026-03-03', tomorrowKey: '2026-03-04' },
      settings,
    }));
    const applyDailyBudgetModel = vi.fn().mockReturnValue({ days: {}, todayKey: '2026-03-03' });
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
      recomputeDailyBudgetToday,
      previewDailyBudgetModel,
      applyDailyBudgetModel,
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
    (app as typeof app & { getLatestPlanSnapshotForUi?: () => Record<string, unknown> | null }).getLatestPlanSnapshotForUi = () => (
      Object.prototype.hasOwnProperty.call(options, 'latestPlanSnapshot')
        ? options.latestPlanSnapshot ?? null
        : defaultPlanSnapshot
    );
    return {
      settings: {
        get: (key: string) => store.get(key),
      },
      cloud: {
        getHomeyId: vi.fn().mockResolvedValue(options.cloudHomeyId ?? 'unlisted-homey-id'),
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
      recomputeDailyBudgetToday,
      previewDailyBudgetModel,
      applyDailyBudgetModel,
      getDeviceDiagnosticsUiPayload,
    };
  };

  it('builds bootstrap payload from current settings and daily budget data', async () => {
    const homey = createHomey();

    const result = await buildSettingsUiBootstrap({ homey: homey as never });

    expect(Object.keys(result.settings)).toEqual([...SETTINGS_UI_BOOTSTRAP_KEYS]);
    expect(result.settings.target_devices_snapshot).toBeUndefined();
    expect(result.settings.combined_prices).toBeUndefined();
    expect(result.dailyBudget).toEqual({ days: {}, todayKey: '2026-03-03' });
    expect((result as unknown as Record<string, unknown>).devices).toBeUndefined();
    expect(result.featureAccess).toEqual({ canToggleOverviewRedesign: false });
    expect(result.plan).toEqual({
      devices: [{ id: 'dev-1', name: 'Heater', priority: 1, reason: buildComparablePlanReason('keep') }],
    });
    expect(result.power).toEqual({
      tracker: { buckets: { '2026-03-03T00:00:00.000Z': 1.2 } },
      status: { lastPowerUpdate: 123, priceLevel: 'cheap' },
      heartbeat: null,
    });
    expect(result.prices.combinedPrices).toEqual({ prices: [{ startsAt: '2026-03-03T00:00:00.000Z', total: 10 }] });
    expect(result.prices.homeyCurrency).toBe('NOK');
  });

  it('allows overview redesign toggles for allowlisted Homey IDs', async () => {
    const homey = createHomey({ cloudHomeyId: 'mock-homey-id' });

    const result = await buildSettingsUiBootstrap({ homey: homey as never });

    expect(result.featureAccess).toEqual({ canToggleOverviewRedesign: true });
  });

  it('grants overview redesign feature access for configured Homey id hashes', async () => {
    const previous = process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES;
    try {
      vi.resetModules();
      process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES = hashHomeyIdForTest('redesign-homey');
      const { buildSettingsUiBootstrap: buildBootstrapWithEnv } = await import('../lib/app/settingsUiApi');
      const homey = createHomey();
      homey.cloud.getHomeyId.mockResolvedValue('redesign-homey');

      const result = await buildBootstrapWithEnv({ homey: homey as never });

      expect(result.featureAccess).toEqual({ canToggleOverviewRedesign: true });
    } finally {
      if (previous === undefined) {
        delete process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES;
      } else {
        process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES = previous;
      }
      vi.resetModules();
    }
  });

  it('keeps overview redesign id hashes fixed after module initialization', async () => {
    const previous = process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES;
    try {
      vi.resetModules();
      process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES = hashHomeyIdForTest('first-redesign-homey');
      const { buildSettingsUiBootstrap: buildBootstrapWithEnv } = await import('../lib/app/settingsUiApi');
      const firstHomey = createHomey();
      firstHomey.cloud.getHomeyId.mockResolvedValue('first-redesign-homey');

      await expect(buildBootstrapWithEnv({ homey: firstHomey as never })).resolves.toMatchObject({
        featureAccess: { canToggleOverviewRedesign: true },
      });

      process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES = hashHomeyIdForTest('second-redesign-homey');
      const secondHomey = createHomey();
      secondHomey.cloud.getHomeyId.mockResolvedValue('second-redesign-homey');

      await expect(buildBootstrapWithEnv({ homey: secondHomey as never })).resolves.toMatchObject({
        featureAccess: { canToggleOverviewRedesign: false },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES;
      } else {
        process.env.PELS_OVERVIEW_REDESIGN_HOMEY_ID_HASHES = previous;
      }
      vi.resetModules();
    }
  });

  it('falls back to disabled feature access when Homey id lookup fails', async () => {
    const homey = createHomey();
    homey.cloud.getHomeyId.mockRejectedValue(new Error('cloud unavailable'));

    const result = await buildSettingsUiBootstrap({ homey: homey as never });

    expect(result.featureAccess).toEqual({ canToggleOverviewRedesign: false });
  });

  it('denies overview redesign access when Homey ID lookup does not return promptly', async () => {
    vi.useFakeTimers();
    try {
      const homey = createHomey();
      homey.cloud.getHomeyId.mockReturnValue(new Promise(() => {}));

      const resultPromise = buildSettingsUiBootstrap({ homey: homey as never });
      await vi.advanceTimersByTimeAsync(500);

      await expect(resultPromise).resolves.toMatchObject({
        featureAccess: { canToggleOverviewRedesign: false },
      });
    } finally {
      vi.useRealTimers();
    }
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

  it('routes daily budget model preview and apply requests through the app', () => {
    const homey = createHomey();
    const body = {
      enabled: true,
      dailyBudgetKWh: 12,
      priceShapingEnabled: false,
      controlledUsageWeight: 0.7,
      priceShapingFlexShare: 0.4,
    };

    const preview = previewSettingsUiDailyBudgetModel({ homey: homey as never, body });
    const applied = applySettingsUiDailyBudgetModel({ homey: homey as never, body });

    expect(homey.previewDailyBudgetModel).toHaveBeenCalledWith(body);
    expect(homey.applyDailyBudgetModel).toHaveBeenCalledWith(body);
    expect(preview?.candidate?.tomorrowKey).toBe('2026-03-04');
    expect(applied?.todayKey).toBe('2026-03-03');
  });

  it('rethrows daily budget recompute failures after logging them', () => {
    const homey = createHomey();
    const error = new Error('recompute failed');
    homey.recomputeDailyBudgetToday.mockImplementation(() => {
      throw error;
    });

    expect(() => recomputeSettingsUiDailyBudget({ homey: homey as never })).toThrow(error);
    expect(homey.error).toHaveBeenCalledWith('Daily budget recompute API failed', error);
  });

  it('builds dedicated read payloads for the remaining volatile UI models', () => {
    const homey = createHomey();

    expect(getSettingsUiDevicesPayload({ homey: homey as never })).toEqual({
      devices: [{ id: 'dev-1', name: 'Heater' }],
    });
    expect(getSettingsUiPlanPayload({ homey: homey as never })).toEqual({
      plan: {
        devices: [{ id: 'dev-1', name: 'Heater', priority: 1, reason: buildComparablePlanReason('keep') }],
      },
    });
    expect(getSettingsUiPowerPayload({ homey: homey as never })).toEqual({
      tracker: { buckets: { '2026-03-03T00:00:00.000Z': 1.2 } },
      status: { lastPowerUpdate: 123, priceLevel: 'cheap' },
      heartbeat: null,
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

  it('prefers the live in-memory plan snapshot over the persisted settings snapshot', async () => {
    const homey = createHomey({
      latestPlanSnapshot: {
        generatedAtMs: 123456789,
        devices: [{ id: 'dev-2', name: 'Pump', priority: 2, reason: buildComparablePlanReason('keep') }],
      },
    });

    await expect(buildSettingsUiBootstrap({ homey: homey as never })).resolves.toMatchObject({
      plan: {
        generatedAtMs: 123456789,
        devices: [{ id: 'dev-2', name: 'Pump', priority: 2, reason: buildComparablePlanReason('keep') }],
      },
    });
    expect(getSettingsUiPlanPayload({ homey: homey as never })).toEqual({
      plan: {
        generatedAtMs: 123456789,
        devices: [{ id: 'dev-2', name: 'Pump', priority: 2, reason: buildComparablePlanReason('keep') }],
      },
    });
  });

  it('returns enriched live plan payloads for redesign consumers', () => {
    const enrichedPlan = {
      generatedAtMs: 123456789,
      meta: {
        totalKw: 6.2,
        softLimitKw: 5,
        headroomKw: -1.2,
        hardCapLimitKw: 7,
        hardCapHeadroomKw: 0.8,
        dailyBudgetHourKWh: 1.9,
      },
      devices: [{
        id: 'dev-2',
        name: 'Pump',
        currentState: 'on',
        plannedState: 'shed',
        stateKind: 'held',
        stateTone: 'held',
        starvation: {
          isStarved: true,
          accumulatedMs: 1_800_000,
          cause: 'capacity',
          startedAtMs: 1234,
        },
        reason: buildComparablePlanReason('capacity'),
      }],
    };
    const homey = createHomey({ latestPlanSnapshot: enrichedPlan });

    expect(getSettingsUiPlanPayload({ homey: homey as never })).toEqual({ plan: enrichedPlan });
  });

  it('drops invalid in-memory app snapshots instead of falling back to settings', async () => {
    const homey = createHomey({
      latestPlanSnapshot: {
        generatedAtMs: 123456789,
        devices: [{ id: 'dev-2', name: 'Pump', priority: 2 }],
      },
    });

    await expect(buildSettingsUiBootstrap({ homey: homey as never })).resolves.toMatchObject({
      plan: null,
    });
    expect(getSettingsUiPlanPayload({ homey: homey as never })).toEqual({ plan: null });
    expect(homey.error).toHaveBeenCalledWith(
      'Ignoring invalid settings UI app plan snapshot: finalized devices must include structured reason',
    );
  });

  it('ignores stale legacy persisted plan snapshots when no in-memory plan is available', async () => {
    const stalePersistedPlanKey = ['device', 'plan', 'snapshot'].join('_');
    const homey = createHomey({
      latestPlanSnapshot: null,
      settings: {
        [stalePersistedPlanKey]: {
          devices: [{ id: 'legacy-dev', name: 'Legacy Heater', priority: 1, reason: buildComparablePlanReason('keep') }],
        },
      },
    });

    await expect(buildSettingsUiBootstrap({ homey: homey as never })).resolves.toMatchObject({
      plan: null,
    });
    expect(getSettingsUiPlanPayload({ homey: homey as never })).toEqual({ plan: null });
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
