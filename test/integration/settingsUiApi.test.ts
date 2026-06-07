import {
  buildSettingsUiBootstrap,
  getSettingsUiDeviceDiagnosticsPayload,
  getSettingsUiDeviceLogPayload,
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
} from '../../setup/settingsUiApi';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../../packages/contracts/src/settingsUiApi';
import { buildComparablePlanReason } from '../../packages/shared-domain/src/planReasonSemantics';

describe('settingsUiApi', () => {
  const createHomey = (
    options: {
      cloudHomeyId?: string;
      latestPlanSnapshot?: Record<string, unknown> | null;
      settings?: Record<string, unknown>;
    } = {},
  ) => {
    const store = new Map<string, unknown>([
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
        persistReason: 'manual',
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
    const getDeviceLogUiPayload = vi.fn().mockReturnValue({
      version: 1,
      entriesByDeviceId: {
        'dev-1': [
          {
            atMs: 1700000000000,
            powerMsg: 'on → off',
            stateMsg: 'Limited',
            usageMsg: 'Measured: 0.00 kW',
            statusMsg: 'Limiting to stay within budget',
            stateKind: 'held',
            stateTone: 'held',
          },
        ],
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
      getDeviceLogUiPayload,
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
        getKeys: () => [...store.keys()],
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
      getDeviceLogUiPayload,
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

  it('serves the assembled per-device objectives under deferred_objectives (not the legacy blob)', async () => {
    // The runtime moved objectives to per-device keys and the migration consumes
    // the blob, so the bootstrap must assemble the V1 map from per-device keys —
    // otherwise the deadline views + PlanDeviceCards (which read this slot, the
    // latter via the settings-cache `applySettingsPatch` primes) would go empty.
    const objective = { enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 21, deadlineAtMs: 9_999_999_999_999 };
    const homey = createHomey({
      settings: {
        deferred_objectives: { version: 1, objectivesByDeviceId: { 'stale-blob-device': objective } }, // legacy blob — must be ignored
        'deferred_objective.heater-1': objective, // per-device key — the source of truth
      },
    });

    const result = await buildSettingsUiBootstrap({ homey: homey as never });

    expect(result.settings.deferred_objectives).toEqual({
      version: 1,
      objectivesByDeviceId: { 'heater-1': objective },
    });
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
      persistReason: 'manual',
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

  it('rethrows daily budget recompute failures so the api wrapper can log them', () => {
    // Logging now lives in `api.ts`'s `withApiLogging` wrapper so every UI API
    // surfaces a single, consistent error log. The helper itself stays
    // throw-through.
    const homey = createHomey();
    const error = new Error('recompute failed');
    homey.recomputeDailyBudgetToday.mockImplementation(() => {
      throw error;
    });

    expect(() => recomputeSettingsUiDailyBudget({ homey: homey as never })).toThrow(error);
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

  it('serves recorded device-log entries from the app', () => {
    const homey = createHomey();

    expect(getSettingsUiDeviceLogPayload({ homey: homey as never })).toEqual({
      version: 1,
      entriesByDeviceId: {
        'dev-1': [
          expect.objectContaining({ stateMsg: 'Limited', statusMsg: 'Limiting to stay within budget' }),
        ],
      },
    });
  });

  it('returns an empty device-log payload when the app has no device-log API yet', () => {
    const homey = createHomey();
    delete (homey.app as { getDeviceLogUiPayload?: unknown }).getDeviceLogUiPayload;

    expect(getSettingsUiDeviceLogPayload({ homey: homey as never })).toEqual({
      version: 1,
      entriesByDeviceId: {},
    });
  });

  it('rethrows device-log API failures so the api wrapper can log them', () => {
    const homey = createHomey();
    homey.getDeviceLogUiPayload.mockImplementation(() => {
      throw new Error('device log not ready');
    });

    expect(() => getSettingsUiDeviceLogPayload({ homey: homey as never })).toThrow('device log not ready');
  });

  it('rethrows diagnostics API failures so the api wrapper can log them', () => {
    // Previously this helper swallowed the throw and returned an empty
    // payload, which silently stripped diagnostics from the device-detail
    // page. Logging + recovery now belongs to the `api.ts` wrapper so the
    // failure reaches `/tmp/pels` and the client sees the real error.
    const homey = createHomey();
    homey.getDeviceDiagnosticsUiPayload.mockImplementation(() => {
      throw new Error('diagnostics not ready');
    });

    expect(() => getSettingsUiDeviceDiagnosticsPayload({ homey: homey as never })).toThrow('diagnostics not ready');
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

  it('throws a PELS_APP_NOT_READY-prefixed error when refresh or reset hits the boot window', async () => {
    const homey = createHomey();
    delete (homey.app as Partial<typeof homey.app>).refreshTargetDevicesSnapshot;
    delete (homey.app as Partial<typeof homey.app>).priceCoordinator;
    delete (homey.app as Partial<typeof homey.app>).replacePowerTrackerForUi;

    await expect(refreshSettingsUiDevices({ homey: homey as never })).rejects.toThrow(
      /^PELS_APP_NOT_READY: Refresh devices unavailable/,
    );
    await expect(refreshSettingsUiPrices({ homey: homey as never })).rejects.toThrow(
      /^PELS_APP_NOT_READY: Refresh prices unavailable/,
    );
    await expect(refreshSettingsUiGridTariff({ homey: homey as never })).rejects.toThrow(
      /^PELS_APP_NOT_READY: Refresh grid tariff unavailable/,
    );
    await expect(resetSettingsUiPowerStats({ homey: homey as never })).rejects.toThrow(
      /^PELS_APP_NOT_READY: Reset power stats unavailable/,
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
