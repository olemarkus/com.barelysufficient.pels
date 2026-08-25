import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
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
  resetSettingsUiPowerStats,
} from '../../setup/settingsUiApi';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../../packages/contracts/src/settingsUiApi';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';

describe('settingsUiApi', () => {
  const createHomey = (
    options: {
      capacityDryRun?: boolean;
      capacitySettings?: { limitKw: number; marginKw: number };
      cloudHomeyId?: string;
      latestPlanSnapshot?: Record<string, unknown> | null;
      settings?: Record<string, unknown>;
      latestDevicesOverride?: Record<string, unknown>[];
      uiPickerDevices?: Record<string, unknown>[];
      observedStateById?: Record<string, Record<string, unknown>>;
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
      devices: [{ id: 'dev-1', name: 'Heater', priority: 1, reason: fixtureDeviceReason('keep')! }],
    };
    // These entries pin the ui_devices wire carriage of the cluster fields the
    // base snapshot type omits: `evChargingState` (EV-observed move),
    // `currentTemperature` (temperature-observed move), `stateOfCharge`
    // (SoC-observed move), `measuredPowerKw` (measured-power-observed move), and —
    // off the descriptor — `steppedLoadProfile` / `targetPowerConfig`
    // (stepped-descriptor move) plus `reportedStepId` (reported-step-observed move).
    // The settings-UI `isEvObserved` / `hasObservedTemperature` /
    // `hasObservedStateOfCharge` / `hasObservedMeasuredPower` / `isSteppedLoadSnapshot`
    // / `hasObservedReportedStep` narrowing (and `supportsPowerDevice`) works only
    // if the served objects physically carry these — a producer rebuild that drops
    // any of them must fail here.
    let latestDevices: Record<string, unknown>[] = options.latestDevicesOverride ?? [
      { id: 'dev-1', name: 'Heater', deviceType: 'temperature', currentTemperature: 18.5, measuredPowerKw: 1.2 },
      {
        id: 'ev-1',
        name: 'Charger',
        deviceClass: 'evcharger',
        evChargingState: 'plugged_in_charging',
        stateOfCharge: stateOfChargeFixture({ percent: 80 }),
        steppedLoadProfile: {
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 4140 },
          ],
        },
        reportedStepId: 'low',
      },
    ];
    // Latched by default (production `recordPowerSample` stamps `lastPowerW`
    // and `lastTimestamp` together): the harness home is a MEASURED home, so
    // the classified `pels_status` read serves the blob as live. Tests for the
    // gated read clear the latch explicitly.
    let powerTracker: Record<string, unknown> = {
      lastPowerW: 5200,
      lastTimestamp: 123,
      buckets: { '2026-03-03T00:00:00.000Z': 1.2 },
    };
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
      ...(typeof options.capacityDryRun === 'boolean'
        ? { capacityDryRun: options.capacityDryRun }
        : {}),
      ...(options.capacitySettings ? { capacitySettings: options.capacitySettings } : {}),
      log,
      error,
      refreshTargetDevicesSnapshot,
      priceCoordinator: {
        refreshSpotPrices,
        refreshGridTariffData,
      },
      replacePowerTrackerForUi,
      getDailyBudgetUiPayload,
      previewDailyBudgetModel,
      applyDailyBudgetModel,
      getDeviceDiagnosticsUiPayload,
      getDeviceLogUiPayload,
      get latestTargetSnapshot() {
        return latestDevices;
      },
      getUiPickerDevices: () => options.uiPickerDevices ?? [],
      getObservedState: (deviceId: string) => options.observedStateById?.[deviceId],
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
    // These keys are no longer part of the bootstrap settings union; assert they
    // are absent by reading them through an index view.
    expect((result.settings as Record<string, unknown>).target_devices_snapshot).toBeUndefined();
    expect((result.settings as Record<string, unknown>).combined_prices).toBeUndefined();
    expect(result.dailyBudget).toEqual({ days: {}, todayKey: '2026-03-03' });
    expect((result as unknown as Record<string, unknown>).devices).toBeUndefined();
    expect(result.plan).toEqual({
      devices: [{ id: 'dev-1', name: 'Heater', priority: 1, reason: fixtureDeviceReason('keep')! }],
    });
    expect(result.power).toEqual({
      tracker: { lastPowerW: 5200, lastTimestamp: 123, buckets: { '2026-03-03T00:00:00.000Z': 1.2 } },
      status: { state: 'live', status: { lastPowerUpdate: 123, priceLevel: 'cheap' } },
      heartbeat: null,
      // No solarpanel-class device in the fixture candidates.
      hasManagedSolarDevice: false,
    });
    expect(result.prices.combinedPrices).toEqual({ prices: [{ startsAt: '2026-03-03T00:00:00.000Z', total: 10 }] });
    expect(result.prices.homeyCurrency).toBe('NOK');
  });

  it('serves the running Main simulation posture even when its setting is absent', () => {
    const homey = createHomey({
      capacityDryRun: false,
      capacitySettings: { limitKw: 12, marginKw: 0.4 },
      settings: { capacity_dry_run: undefined },
    });

    expect(getSettingsUiPowerPayload({ homey: homey as never }).mainDryRunEffective).toBe(false);
    expect(getSettingsUiPowerPayload({ homey: homey as never }).mainCapacityScalars)
      .toEqual({ limitKw: 12, marginKw: 0.4 });
  });

  // The read boundary classifies the persisted `pels_status` blob against the
  // same predicate the plan-build gate asks of the same live tracker
  // (`hasPowerMeasurement`). A gated boot — no meter reading THIS run — must
  // not serve the previous run's blob as live, and must not destroy it either.
  it('answers no_measurement — and preserves the stored blob — while the live tracker holds no measurement', () => {
    const homey = createHomey();
    // A gated boot: the live tracker restored no latch (never sampled this
    // run / corrupt restore / in-place meter swap cleared it).
    (homey.app as { powerTracker: unknown }).powerTracker = { buckets: { '2026-03-03T00:00:00.000Z': 1.2 } };

    const payload = getSettingsUiPowerPayload({ homey: homey as never });
    expect(payload.status).toEqual({ state: 'unavailable', reason: 'no_measurement' });
    // Usage HISTORY still serves — the tracker field is accounting, not a
    // liveness claim; its consumers age it themselves.
    expect(payload.tracker).toEqual({ buckets: { '2026-03-03T00:00:00.000Z': 1.2 } });
    // The persisted blob survives untouched: a shut gate changes only what the
    // read CLAIMS, never the stored state.
    expect(homey.settings.get('pels_status')).toEqual({ lastPowerUpdate: 123, priceLevel: 'cheap' });
  });

  it('answers no_status_recorded when the home is measured but no pels_status blob is committed yet', () => {
    const homey = createHomey({ settings: { pels_status: undefined } });
    expect(getSettingsUiPowerPayload({ homey: homey as never }).status)
      .toEqual({ state: 'unavailable', reason: 'no_status_recorded' });
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
      // Reset clears STATS, not the measurement latch: `...currentState`
      // carries `lastPowerW`/`lastTimestamp` forward, so the home stays
      // measured and the classified status read stays live across a reset.
      lastPowerW: 5200,
      lastTimestamp: 123,
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
      generationBuckets: {},
      exportBuckets: {},
      generationDailyTotals: {},
      exportDailyTotals: {},
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

  it('builds dedicated read payloads for the remaining volatile UI models', () => {
    const homey = createHomey();

    expect(getSettingsUiDevicesPayload({ homey: homey as never })).toEqual({
      devices: [
        { id: 'dev-1', name: 'Heater', deviceType: 'temperature', currentTemperature: 18.5, measuredPowerKw: 1.2 },
        {
          id: 'ev-1',
          name: 'Charger',
          deviceClass: 'evcharger',
          evChargingState: 'plugged_in_charging',
          stateOfCharge: stateOfChargeFixture({ percent: 80 }),
          steppedLoadProfile: {
            steps: [
              { id: 'off', planningPowerW: 0 },
              { id: 'low', planningPowerW: 4140 },
            ],
          },
          reportedStepId: 'low',
        },
      ],
      hasManagedSolarDevice: false,
      hasExhibitedExport: false,
      // No export history and no curtailment seam wired: the surplus engine has
      // nothing to allocate, so the toggle is not offered.
      surplusPoolReachable: false,
    });
    expect(getSettingsUiPlanPayload({ homey: homey as never })).toEqual({
      plan: {
        devices: [{ id: 'dev-1', name: 'Heater', priority: 1, reason: fixtureDeviceReason('keep')! }],
      },
    });
    expect(getSettingsUiPowerPayload({ homey: homey as never })).toEqual({
      tracker: { lastPowerW: 5200, lastTimestamp: 123, buckets: { '2026-03-03T00:00:00.000Z': 1.2 } },
      status: { state: 'live', status: { lastPowerUpdate: 123, priceLevel: 'cheap' } },
      heartbeat: null,
      // No solarpanel-class device in the fixture candidates.
      hasManagedSolarDevice: false,
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

  it('carries the solar tracker families through the ui_power payload verbatim', () => {
    // PR-5 solar visibility: the Usage-tab Solar card and the Overview
    // "Solar now" subline read these fields straight off the tracker payload —
    // the producer serves the persisted state as-is, so a rebuild that strips
    // or re-shapes the solar families must fail here.
    const trackerWithSolar = {
      buckets: { '2026-03-03T00:00:00.000Z': 1.2 },
      generationBuckets: { '2026-03-03T10:00:00.000Z': 2.4 },
      exportBuckets: { '2026-03-03T10:00:00.000Z': 0.8 },
      generationDailyTotals: { '2026-02-01': 5.5 },
      exportDailyTotals: { '2026-02-01': 1.5 },
      lastGenerationW: 3200,
      lastPowerW: -1500,
      lastTimestamp: 123,
    };
    const homey = createHomey({
      settings: { power_source: 'homey_energy' },
      latestDevicesOverride: [
        { id: 'heater-1', name: 'Heater', deviceType: 'temperature' },
        { id: 'pv-1', name: 'Solar Roof', deviceClass: 'solarpanel' },
      ],
    });
    // The producer prefers the LIVE app tracker over the persisted settings
    // read — set it there, mirroring a running solar home.
    (homey.app as { powerTracker: unknown }).powerTracker = trackerWithSolar;
    const payload = getSettingsUiPowerPayload({ homey: homey as never });
    expect(payload.tracker).toEqual(trackerWithSolar);
    // The home-level solar flag rides the power payload (the device list is
    // lazy-loaded, so the Usage Solar card gates on this copy of the signal).
    expect(payload.hasManagedSolarDevice).toBe(true);
  });

  it('raises the power payload solar flag on EITHER power source when a PV device exists', () => {
    // Production is read from the Homey Energy report on both sources — directly
    // on the homey_energy poll, and via the companion poll on flow — so a solar
    // home's generation buckets fill either way. The flag used to be gated on
    // the source because the flow path had no production reader at all; that is
    // no longer a configuration that exists.
    const solarDevices = [
      { id: 'heater-1', name: 'Heater', deviceType: 'temperature' },
      { id: 'pv-1', name: 'Solar Roof', deviceClass: 'solarpanel' },
    ];
    const flowHomey = createHomey({
      settings: { power_source: 'flow' },
      latestDevicesOverride: solarDevices,
    });
    expect(getSettingsUiPowerPayload({ homey: flowHomey as never }).hasManagedSolarDevice).toBe(true);
    // Unset power_source normalizes to flow (the historical read semantics).
    const unsetHomey = createHomey({ latestDevicesOverride: solarDevices });
    expect(getSettingsUiPowerPayload({ homey: unsetHomey as never }).hasManagedSolarDevice).toBe(true);
    // Still false without a PV device: the flag is device presence, not source.
    const noPvHomey = createHomey({
      settings: { power_source: 'flow' },
      latestDevicesOverride: [{ id: 'heater-1', name: 'Heater', deviceType: 'temperature' }],
    });
    expect(getSettingsUiPowerPayload({ homey: noPvHomey as never }).hasManagedSolarDevice).toBe(false);
  });

  it('hides auto-tracked observe-only battery/PV devices from the settings-UI device list', () => {
    // Home batteries (class-key 'battery') and PV (class-key 'solarpanel') are
    // FORCE-MANAGED observe-only devices: they ride the backend snapshot
    // (`latestTargetSnapshot`) for telemetry but the user never opted into
    // managing them and cannot control them. They must NOT leak into the
    // user-facing device list with a no-op "Manage" toggle. The managed half
    // (`latestTargetSnapshot`) carries them; the picker half already drops them
    // (managerManagedFilter) — assert BOTH inputs filter, and that a normal
    // managed heater stays present.
    const homey = createHomey({
      latestDevicesOverride: [
        { id: 'heater-1', name: 'Heater', deviceType: 'temperature' },
        { id: 'batt-1', name: 'Home Battery', deviceClass: 'battery' },
        { id: 'pv-1', name: 'Solar Roof', deviceClass: 'solarpanel' },
      ],
      // A picker that (defensively) still surfaced an observe-only device must
      // also be filtered out here, so the payload never double-renders it.
      uiPickerDevices: [
        { id: 'pump-1', name: 'Pump', deviceType: 'onoff' },
        { id: 'batt-2', name: 'Other Battery', deviceClass: 'battery' },
      ],
    });

    const { devices } = getSettingsUiDevicesPayload({ homey: homey as never });
    const ids = devices.map((device) => device.id);

    expect(ids).toContain('heater-1');
    expect(ids).toContain('pump-1');
    expect(ids).not.toContain('batt-1');
    expect(ids).not.toContain('pv-1');
    expect(ids).not.toContain('batt-2');
    // The BACKEND snapshot is untouched — the force-managed observe-only devices
    // are still tracked there for telemetry; only this UI payload excludes them.
    const backendSnapshot = homey.app.latestTargetSnapshot as Record<string, unknown>[];
    expect(backendSnapshot.map((device) => device.id)).toEqual(['heater-1', 'batt-1', 'pv-1']);
    // Although the PV device is excluded from `devices`, its presence is still reported as
    // the home-level solar flag so the UI can gate the per-device "Use solar surplus" control.
    expect(getSettingsUiDevicesPayload({ homey: homey as never }).hasManagedSolarDevice).toBe(true);
  });

  it('serves the observer projection\'s observed state, not the stored snapshot\'s', () => {
    // `latestTargetSnapshot` is rebuilt only at :25/:55, so the observed half it
    // carries goes up to half an hour stale. The projection is the observer's
    // current answer, and `/ui_devices` is read continuously — so the payload
    // must reflect the projection.
    const homey = createHomey({
      latestDevicesOverride: [{
        id: 'heater-1',
        name: 'Heater',
        deviceType: 'temperature',
        capabilities: ['onoff', 'target_temperature'],
        available: true,
        measuredPowerKw: 0.4,
        binaryControl: { on: true },
      }],
      observedStateById: {
        'heater-1': {
          id: 'heater-1',
          name: 'Heater',
          available: false,
          measuredPowerKw: 2.7,
          binaryControl: { on: false },
        },
      },
    });

    // One structural assertion covers both halves: the raw-observed fields are
    // the projection's, and every descriptor field is still the stored one.
    // `binaryControl` IS refreshed here — this device is not a stepped load, so
    // nothing resolved it and the stored value is just an older observation.
    expect(getSettingsUiDevicesPayload({ homey: homey as never }).devices).toEqual([{
      id: 'heater-1',
      name: 'Heater',
      deviceType: 'temperature',
      capabilities: ['onoff', 'target_temperature'],
      available: false,
      measuredPowerKw: 2.7,
      binaryControl: { on: false },
    }]);
  });

  it('does not let the raw observation overwrite what the control decorator resolved', () => {
    // `decorateSnapshotWithDeviceControl` RESOLVES a stepped load's binary axis
    // from its selected rung, and clears `reportedStepId` for a
    // temperature-control-disabled device. Both look like observations and are
    // not — refreshing them from raw transport state would put the decorator's
    // answer back to the un-resolved one.
    const homey = createHomey({
      latestDevicesOverride: [{
        id: 'heater-1',
        name: 'Heater',
        controlModel: 'stepped_load',
        selectedStepId: 'off',
        binaryControl: { on: false },
        reportedStepId: undefined,
        measuredPowerKw: 0.1,
      }],
      observedStateById: {
        'heater-1': {
          id: 'heater-1',
          name: 'Heater',
          binaryControl: { on: true },
          reportedStepId: 'low',
          measuredPowerKw: 3.3,
        },
      },
    });

    const [device] = getSettingsUiDevicesPayload({ homey: homey as never }).devices;

    expect(device.binaryControl).toEqual({ on: false });
    expect(device.reportedStepId).toBeUndefined();
    // The raw-observed field beside them IS refreshed, so this is a targeted
    // exclusion and not the overlay failing to run. The `binaryControl`
    // exclusion is scoped to `stepped_load` — the test above covers an ordinary
    // binary device, whose on/off IS refreshed.
    expect(device).toMatchObject({ measuredPowerKw: 3.3 });
  });

  it('serves an unmanaged picker device from its cached parse', () => {
    // The projection is fed from the committed runtime snapshot, which drops
    // unmanaged devices — so a picker row has no entry and is NOT refreshed
    // here. Pinned so the absence is a known limit rather than a surprise.
    const homey = createHomey({
      latestDevicesOverride: [],
      uiPickerDevices: [{ id: 'pump-9', name: 'Pump', available: true }],
      observedStateById: {},
    });

    expect(getSettingsUiDevicesPayload({ homey: homey as never }).devices).toEqual([
      { id: 'pump-9', name: 'Pump', available: true },
    ]);
  });

  it('keeps the stored snapshot for a device the projection has no entry for', () => {
    // Absence in the projection means "never observed yet", not "observed to be
    // nothing" — blanking the device's observed state on it would invent a
    // reading PELS never took.
    const homey = createHomey({
      latestDevicesOverride: [{
        id: 'heater-1',
        name: 'Heater',
        available: true,
        measuredPowerKw: 0.4,
        binaryControl: { on: true },
      }],
      observedStateById: {},
    });

    expect(getSettingsUiDevicesPayload({ homey: homey as never }).devices).toEqual([{
      id: 'heater-1',
      name: 'Heater',
      available: true,
      measuredPowerKw: 0.4,
      binaryControl: { on: true },
    }]);
  });

  it('reports hasManagedSolarDevice=false when the home has only a battery and no PV', () => {
    // A home battery is observe-only but is NOT solar — surplus self-consumption requires
    // generation, so a battery alone must not unlock the solar surplus control.
    const homey = createHomey({
      latestDevicesOverride: [
        { id: 'heater-1', name: 'Heater', deviceType: 'temperature' },
        { id: 'batt-1', name: 'Home Battery', deviceClass: 'battery' },
      ],
    });
    expect(getSettingsUiDevicesPayload({ homey: homey as never }).hasManagedSolarDevice).toBe(false);
  });

  it('unlocks the surplus toggle for a meter-only PV home via hasExhibitedExport', () => {
    // Meter-only PV: a string inverter reports export through Homey Energy but no
    // `solarpanel` device exists, so `hasManagedSolarDevice` is false. The stable
    // accumulated export-kWh signal broadens the "Use solar surplus" toggle gate
    // to it — the surplus-absorb engine already works off whole-home net export.
    const homey = createHomey({
      settings: { power_source: 'homey_energy' },
      latestDevicesOverride: [{ id: 'heater-1', name: 'Heater', deviceType: 'temperature' }],
    });
    (homey.app as { powerTracker: unknown }).powerTracker = {
      exportDailyTotals: { '2026-02-01': 4.5 },
    };
    const payload = getSettingsUiDevicesPayload({ homey: homey as never });
    expect(payload.hasManagedSolarDevice).toBe(false);
    expect(payload.hasExhibitedExport).toBe(true);
  });

  it('keeps hasExhibitedExport false below the material floor, on either power source', () => {
    // A sub-kWh export blip stays under the material floor on both sources —
    // the floor is what prevents toggle flicker, and it is the ONLY thing
    // holding the flag down.
    const tinyHomey = createHomey({
      settings: { power_source: 'homey_energy' },
      latestDevicesOverride: [{ id: 'heater-1', name: 'Heater', deviceType: 'temperature' }],
    });
    (tinyHomey.app as { powerTracker: unknown }).powerTracker = {
      exportBuckets: { '2026-03-03T10:00:00.000Z': 0.2 },
    };
    expect(getSettingsUiDevicesPayload({ homey: tinyHomey as never }).hasExhibitedExport).toBe(false);

    const tinyFlowHomey = createHomey({
      settings: { power_source: 'flow' },
      latestDevicesOverride: [{ id: 'heater-1', name: 'Heater', deviceType: 'temperature' }],
    });
    (tinyFlowHomey.app as { powerTracker: unknown }).powerTracker = {
      exportBuckets: { '2026-03-03T10:00:00.000Z': 0.2 },
    };
    expect(getSettingsUiDevicesPayload({ homey: tinyFlowHomey as never }).hasExhibitedExport).toBe(false);
  });

  it('reports hasExhibitedExport on the flow source too — export is source-blind', () => {
    // The flow card accepts signed watts, so a flow home's export families fill
    // on exactly the same evidence as a Homey Energy one. The flag must read the
    // accrued export, never the source name.
    const flowHomey = createHomey({
      settings: { power_source: 'flow' },
      latestDevicesOverride: [{ id: 'heater-1', name: 'Heater', deviceType: 'temperature' }],
    });
    (flowHomey.app as { powerTracker: unknown }).powerTracker = {
      exportDailyTotals: { '2026-02-01': 9.9 },
    };
    expect(getSettingsUiDevicesPayload({ homey: flowHomey as never }).hasExhibitedExport).toBe(true);
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
        devices: [{ id: 'dev-2', name: 'Pump', priority: 2, reason: fixtureDeviceReason('keep')! }],
      },
    });

    await expect(buildSettingsUiBootstrap({ homey: homey as never })).resolves.toMatchObject({
      plan: {
        generatedAtMs: 123456789,
        devices: [{ id: 'dev-2', name: 'Pump', priority: 2, reason: fixtureDeviceReason('keep')! }],
      },
    });
    expect(getSettingsUiPlanPayload({ homey: homey as never })).toEqual({
      plan: {
        generatedAtMs: 123456789,
        devices: [{ id: 'dev-2', name: 'Pump', priority: 2, reason: fixtureDeviceReason('keep')! }],
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
        },
        reason: fixtureDeviceReason('shed due to capacity')!,
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
          devices: [{ id: 'legacy-dev', name: 'Legacy Heater', priority: 1, reason: fixtureDeviceReason('keep')! }],
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
