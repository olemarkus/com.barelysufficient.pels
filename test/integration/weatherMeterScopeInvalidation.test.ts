import type Homey from 'homey';
import type { Logger as PinoLogger } from 'pino';
import { MockSettings } from '../mocks/homey';
import { createSettingsHandler, type SettingsHandlerDeps } from '../../lib/utils/settingsHandlers';
import { createWeatherHistoryStore } from '../../setup/weatherHistoryStateAdapter';
import { readMainMeterSelection } from '../../setup/mainMeterSettings';
import { readConfiguredPowerSource } from '../../setup/powerSourceSettings';
import { readWholeHomeMeterScopeSignature } from '../../setup/weatherMeterScopeSignature';
import { WeatherCollector, type WeatherCollectorDeps } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import {
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  HOMEY_ENERGY_METER_DEVICE_ID,
  POWER_SOURCE,
  WEATHER_ADVISOR_SETTINGS,
  WEATHER_HISTORY_STATE,
} from '../../lib/utils/settingsKeys';
import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';

// Integration seam: a settings write dispatched through the real
// createSettingsHandler must reach the real collector (real history-store
// adapter over MockSettings, real meter-scope signature composition over the
// real homes-store adapter) and make it forget the meter-derived state in BOTH
// memory and the persisted store. Only the outward seams (device transport,
// Insights REST) are stubbed. A store-only clear would pass none of this: the
// collector flushes its in-memory blob back over the store on every restart,
// so the forget must be collector-owned.

const OSLO = 'Europe/Oslo';
const START_MS = Date.UTC(2026, 0, 10, 10, 0, 0);
const MAIN_METER = 'meter-main-1';
const AREA_METER = 'meter-area-1';
// The harness runs on Homey Energy: the meter-scope fingerprint (and the
// meter election it re-arms) is that producer's concern; the Flow arm is
// exercised by the source-switch spec below.
const STAMPED_SIGNATURE = `source:homey_energy|main:${MAIN_METER}`;
const AUTOMATIC_ACTIVE_SIGNATURE = 'source:homey_energy|main:automatic|areas:active';

const areaConfig = (meterDeviceId: string, name = 'Annex') => ({
  activationVersion: 1,
  subHomes: [{ homeId: 'h_area1', name, rootZoneId: 'z-annex', meterDeviceId }],
});

const dormantAreaConfig = (meterDeviceId: string) => ({
  subHomes: [{ homeId: 'h_area1', name: 'Annex', rootZoneId: 'z-annex', meterDeviceId }],
});

const learnedHistory = (overrides: Partial<WeatherHistoryState> = {}): WeatherHistoryState => ({
  records: [{
    dateKey: '2026-01-05',
    kwhTotal: 30,
    tempMeanC: -5,
    tempMinC: -8,
    tempMaxC: -2,
    tempSampleCount: 20,
    quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
  }],
  backfilledDeviceId: 'out-1',
  backfillVersion: 2,
  meterKwhBackfillDone: true,
  meterKwhDeviceId: MAIN_METER,
  kwhPurgeVersion: 1,
  controlledBackfillVersion: 2,
  latestFit: { model: 'linear', slopeKwhPerDegree: 1.2 } as WeatherHistoryState['latestFit'],
  meterScopeSignature: STAMPED_SIGNATURE,
  ...overrides,
});

type Harness = {
  homey: { settings: MockSettings };
  collector: WeatherCollector;
  handle: (key: string) => Promise<void>;
  weatherLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  stop: () => void;
};

const buildHarness = (
  history: WeatherHistoryState,
  overrides: Partial<Pick<
  WeatherCollectorDeps,
  'fetchInsights' | 'getDailyKwh' | 'readMeterScopeSignature'
  >> = {},
  options: {
    failHomesMarkerBackfill?: boolean;
    homesConfig?: unknown;
    mainMeter?: unknown;
    omitHomesConfig?: boolean;
    powerSource?: unknown;
  } = {},
): Harness => {
  const homey = { settings: new MockSettings() };
  const homeyCast = homey as unknown as Homey.App['homey'];
  homey.settings.set(WEATHER_ADVISOR_SETTINGS, { enabled: true, outdoorDeviceId: 'out-1' });
  homey.settings.set(POWER_SOURCE, 'powerSource' in options ? options.powerSource : 'homey_energy');
  homey.settings.set(
    HOMEY_ENERGY_METER_DEVICE_ID,
    'mainMeter' in options ? options.mainMeter : MAIN_METER,
  );
  if (options.omitHomesConfig !== true) {
    homey.settings.set(HOMES_CONFIG, options.homesConfig ?? areaConfig(AREA_METER));
  }
  homey.settings.set(WEATHER_HISTORY_STATE, history);
  if (options.failHomesMarkerBackfill === true) {
    const originalSet = homey.settings.set.bind(homey.settings);
    vi.spyOn(homey.settings, 'set').mockImplementation((key: string, value: unknown) => {
      if (key === HOMES_CONFIG_INITIALIZED) throw new Error('marker write failed');
      originalSet(key, value);
    });
  }
  const weatherLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const collector = new WeatherCollector({
    store: createWeatherHistoryStore(homeyCast),
    readDevice: async () => ({
      id: 'out-1',
      name: 'Outdoor',
      capabilitiesObj: { measure_temperature: { value: -3.5 } },
    }),
    // Never resolves: keeps the re-armed meter backfill observably in flight
    // instead of racing the assertions with its no-source completion.
    fetchInsights: () => new Promise(() => {}),
    getDailyKwh: () => ({ total: 18 }),
    isManagedDevice: () => false,
    getUnreliablePeriods: () => [],
    getDaySuppression: () => ({}),
    getAppliedDailyBudgetKwh: () => 50,
    getSettings: () => buildWeatherAdvisorSettings({ settings: homey.settings }),
    readMeterScopeSignature: () => readWholeHomeMeterScopeSignature(homeyCast),
    readMainMeterSelection: () => readMainMeterSelection(homey.settings),
    readPowerSource: () => readConfiguredPowerSource(homey.settings),
    getNowMs: () => Date.now(),
    getTimeZone: () => OSLO,
    logger: weatherLogger as unknown as PinoLogger,
    ...overrides,
  });
  const deps: SettingsHandlerDeps = {
    homey: homeyCast as unknown as SettingsHandlerDeps['homey'],
    onPvForecastSourceObserved: vi.fn(),
    loadCapacitySettings: vi.fn(),
    reloadExpectedPowerOverrides: vi.fn(),
    rebuildPlanFromCache: vi.fn().mockResolvedValue(undefined),
    refreshTargetDevicesSnapshot: vi.fn().mockResolvedValue(undefined),
    loadPowerTracker: vi.fn(),
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
    // The production wiring for this hook (`ctx.reloadWeatherCollector`)
    // restarts the collector; start() begins with stop(), so this is the
    // same restart edge BackgroundTasksController drives.
    reloadWeatherAdvisor: () => { collector.start(); },
  };
  const handler = createSettingsHandler(deps);
  collector.start();
  return {
    homey,
    collector,
    handle: (key: string) => handler(key),
    weatherLogger,
    stop: () => { handler.stop(); collector.stop(); },
  };
};

const persistedState = (homey: { settings: MockSettings }): WeatherHistoryState => (
  homey.settings.get(WEATHER_HISTORY_STATE) as WeatherHistoryState
);

describe('weather meter-scope invalidation through the settings-change seam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps everything when an area\'s meter changes — area meters never feed Main\'s retained history', async () => {
    const harness = buildHarness(learnedHistory());
    await vi.advanceTimersByTimeAsync(0);
    // Sanity: the seeded arrangement matches the stamp — nothing forgotten.
    expect(harness.collector.getHistoryStateSnapshot().meterKwhBackfillDone).toBe(true);
    expect(harness.collector.isBackfillRunning()).toBe(false);

    harness.homey.settings.set(HOMES_CONFIG, areaConfig('meter-area-2'));
    await harness.handle(HOMES_CONFIG);

    // Area meters are fenced OUT of Main's admitted samples, so an area
    // re-meter is routine maintenance: Main's kWh series is untouched and a
    // forget here would discard years of evidence for nothing.
    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterKwhBackfillDone).toBe(true);
    expect(memory.latestFit).toBeDefined();
    expect(memory.meterScopeSignature).toBe(STAMPED_SIGNATURE);
    expect(memory.records[0].kwhTotal).toBe(30);
    expect(harness.collector.isBackfillRunning()).toBe(false);
    expect(persistedState(harness.homey).meterKwhBackfillDone).toBe(true);
    expect(harness.weatherLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_scope_invalidated',
    }));
    harness.stop();
  });

  it('adopts the live explicit signature over a persisted legacy Automatic stamp WITHOUT forgetting', async () => {
    // The upgrade path for installs stamped under the retired
    // `main:automatic|areas:*` arm: that stamp now classifies INVALID in the
    // persisted state, and the documented invalid-pair policy adopts the live
    // explicit signature while keeping every learned record and marker.
    const harness = buildHarness(
      learnedHistory({ meterScopeSignature: AUTOMATIC_ACTIVE_SIGNATURE }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterScopeSignature).toBe(STAMPED_SIGNATURE);
    expect(memory.meterKwhBackfillDone).toBe(true);
    expect(memory.latestFit).toBeDefined();
    expect(memory.records[0].kwhTotal).toBe(30);
    expect(harness.weatherLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_scope_invalidated',
    }));
    harness.stop();
  });

  it('preserves learned history when a dormant roster activates under an explicit Main meter', async () => {
    const harness = buildHarness(
      learnedHistory(),
      {},
      { homesConfig: dormantAreaConfig(AREA_METER) },
    );
    await vi.advanceTimersByTimeAsync(0);

    harness.homey.settings.set(HOMES_CONFIG, areaConfig(AREA_METER));
    await harness.handle(HOMES_CONFIG);

    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterScopeSignature).toBe(STAMPED_SIGNATURE);
    expect(memory.meterScopeSinceDateKey).toBeUndefined();
    expect(memory.meterKwhBackfillDone).toBe(true);
    expect(memory.latestFit).toBeDefined();
    expect(memory.records[0].kwhTotal).toBe(30);
    expect(persistedState(harness.homey).records[0].kwhTotal).toBe(30);
    expect(harness.weatherLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_scope_invalidated',
    }));
    harness.stop();
  });

  it('forgets when the Main whole-home meter selection changes', async () => {
    const trackerRead = vi.fn(() => ({ total: 30 }));
    const harness = buildHarness(learnedHistory(), {
      getDailyKwh: trackerRead,
      fetchInsights: async (path: string) => (
        path === 'manager/devices/device'
          ? {}
          : { step: 6 * 60 * 60 * 1000, values: [] }
      ),
    });
    await vi.advanceTimersByTimeAsync(0);

    harness.homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main-2');
    await harness.handle(HOMEY_ENERGY_METER_DEVICE_ID);
    await vi.advanceTimersByTimeAsync(0);

    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterKwhBackfillDone).toBeUndefined();
    expect(memory.latestFit).toBeUndefined();
    expect(memory.meterScopeSignature).toBe('source:homey_energy|main:meter-main-2');
    expect(memory.meterScopeSinceDateKey).toBe('2026-01-10');
    // The re-armed no-candidate path must not refill the stripped record from
    // tracker buckets collected under meter-main-1. The epoch rejects every
    // day on or before the switch day before the underlying tracker is read.
    expect(memory.records[0].kwhTotal).toBeUndefined();
    expect(trackerRead).not.toHaveBeenCalled();
    expect(persistedState(harness.homey).meterKwhBackfillDone).toBeUndefined();
    harness.stop();
  });

  it('forgets on a switch to Flow and never re-runs the meter election against the stored Main meter', async () => {
    // The still-stored (and still-installed) Homey meter could satisfy the
    // overlap validation entirely from the retained pre-switch tracker
    // buckets. On the Flow producer the election must not run at all — not
    // even restricted to that meter — or it would re-vouch old-scope days
    // under the new `source:flow` stamp before any Flow evidence exists.
    const insightsPaths: string[] = [];
    const harness = buildHarness(learnedHistory(), {
      fetchInsights: async (path: string) => {
        insightsPaths.push(path);
        if (path === 'manager/devices/device') {
          return { [MAIN_METER]: { id: MAIN_METER, capabilities: ['meter_power.imported'] } };
        }
        return { step: 6 * 60 * 60 * 1000, values: [] };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    // Sanity: the stamped arrangement matches — nothing forgotten yet.
    expect(harness.collector.getHistoryStateSnapshot().meterKwhBackfillDone).toBe(true);

    harness.homey.settings.set(POWER_SOURCE, 'flow');
    await harness.handle(POWER_SOURCE);
    await vi.advanceTimersByTimeAsync(0);

    const expectedSignature = 'source:flow';
    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterKwhBackfillDone).toBeUndefined();
    expect(memory.latestFit).toBeUndefined();
    expect(memory.meterScopeSignature).toBe(expectedSignature);
    expect(memory.meterScopeSinceDateKey).toBe('2026-01-10');
    expect(memory.records[0].kwhTotal).toBeUndefined();
    expect(memory.records[0]).toMatchObject({
      tempMeanC: -5,
      quality: { missingKwh: true },
    });
    const persisted = persistedState(harness.homey);
    expect(persisted.meterKwhBackfillDone).toBeUndefined();
    expect(persisted.meterScopeSinceDateKey).toBe('2026-01-10');
    expect(persisted.records[0].kwhTotal).toBeUndefined();
    expect(harness.weatherLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_scope_invalidated',
      previousSignature: STAMPED_SIGNATURE,
      currentSignature: expectedSignature,
    }));
    // The re-armed backfill concluded synchronously as a no-source election:
    // no device listing, no candidate probe, nothing in flight.
    expect(insightsPaths).toHaveLength(0);
    expect(harness.collector.isBackfillRunning()).toBe(false);
    expect(harness.weatherLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_backfill_no_source',
      outcome: 'flow_source',
    }));
    // The switch day is mixed and therefore rolls up without tracker kWh.
    // The following full local day belongs wholly to Flow and is admitted.
    await vi.advanceTimersByTimeAsync((13 * 60 + 6) * 60 * 1000);
    expect(harness.collector.getHistoryStateSnapshot().records.find(
      (record) => record.dateKey === '2026-01-10',
    )?.kwhTotal).toBeUndefined();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(harness.collector.getHistoryStateSnapshot().records.find(
      (record) => record.dateKey === '2026-01-11',
    )?.kwhTotal).toBe(18);
    harness.stop();
  });

  it('invalidates Homey Energy → Flow → Homey Energy for a normal single-home setup', async () => {
    const harness = buildHarness(
      learnedHistory(),
      {},
      { omitHomesConfig: true },
    );
    await vi.advanceTimersByTimeAsync(0);

    harness.homey.settings.set(POWER_SOURCE, 'flow');
    await harness.handle(POWER_SOURCE);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.collector.getHistoryStateSnapshot()).toMatchObject({
      meterScopeSignature: 'source:flow',
      meterScopeSinceDateKey: '2026-01-10',
    });

    harness.homey.settings.set(POWER_SOURCE, 'homey_energy');
    await harness.handle(POWER_SOURCE);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.collector.getHistoryStateSnapshot()).toMatchObject({
      meterScopeSignature: STAMPED_SIGNATURE,
      meterScopeSinceDateKey: '2026-01-10',
    });
    expect(harness.weatherLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_scope_invalidated',
      previousSignature: 'source:flow',
      currentSignature: STAMPED_SIGNATURE,
    }));
    harness.stop();
  });

  it('binds the re-armed kWh election to the newly selected Main meter — the old meter is never probed', async () => {
    // Both meters remain installed; the OLD one would win an open election
    // (its pre-switch days match the retained tracker history strongest) and
    // re-vouch old-scope kWh under the new stamp.
    const insightsPaths: string[] = [];
    const harness = buildHarness(learnedHistory(), {
      fetchInsights: async (path: string) => {
        insightsPaths.push(path);
        if (path === 'manager/devices/device') {
          return {
            [MAIN_METER]: { id: MAIN_METER, capabilities: ['meter_power.imported'] },
            'meter-main-2': { id: 'meter-main-2', capabilities: ['meter_power.imported'] },
          };
        }
        return { step: 6 * 60 * 60 * 1000, values: [] };
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    harness.homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main-2');
    await harness.handle(HOMEY_ENERGY_METER_DEVICE_ID);
    await vi.advanceTimersByTimeAsync(0);

    const probed = insightsPaths.filter((path) => path.includes('homey:device:'));
    expect(probed.some((path) => path.includes('homey:device:meter-main-2'))).toBe(true);
    expect(probed.some((path) => path.includes(`homey:device:${MAIN_METER}`))).toBe(false);
    // The empty-history candidate cannot validate: the election concludes
    // without re-latching the marker instead of resolving to the old meter.
    expect(harness.collector.getHistoryStateSnapshot().meterKwhBackfillDone).toBeUndefined();
    harness.stop();
  });

  it('keeps everything on a scope-neutral homes_config write (rename)', async () => {
    const harness = buildHarness(learnedHistory());
    await vi.advanceTimersByTimeAsync(0);

    harness.homey.settings.set(HOMES_CONFIG, areaConfig(AREA_METER, 'Renamed annex'));
    await harness.handle(HOMES_CONFIG);

    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterKwhBackfillDone).toBe(true);
    expect(memory.latestFit).toBeDefined();
    expect(memory.meterScopeSignature).toBe(STAMPED_SIGNATURE);
    expect(memory.records[0].kwhTotal).toBe(30);
    expect(harness.collector.isBackfillRunning()).toBe(false);
    harness.stop();
  });

  it('never forgets on a transiently unreadable Main selection — failed read is not change evidence', async () => {
    const harness = buildHarness(learnedHistory());
    await vi.advanceTimersByTimeAsync(0);

    // A nulled meter read classifies the selection unavailable → the
    // signature composes to undefined, and ambiguity never forgets.
    harness.homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    await harness.handle(HOMEY_ENERGY_METER_DEVICE_ID);

    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterKwhBackfillDone).toBe(true);
    expect(memory.latestFit).toBeDefined();
    expect(memory.meterScopeSignature).toBe(STAMPED_SIGNATURE);
    harness.stop();
  });


  it('defers the meter election while the Main selection is unreadable', async () => {
    const fetchInsights = vi.fn(async () => ({ step: 6 * 60 * 60 * 1000, values: [] }));
    const history = learnedHistory({
      meterKwhBackfillDone: undefined,
      meterKwhDeviceId: undefined,
      kwhPurgeVersion: undefined,
    });
    const harness = buildHarness(history, { fetchInsights }, { mainMeter: 42 });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchInsights).not.toHaveBeenCalled();
    expect(harness.weatherLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_scope_reconcile_deferred',
    }));
    expect(harness.collector.getHistoryStateSnapshot().meterKwhBackfillDone).toBeUndefined();
    harness.stop();
  });

  it('defers the meter election while the power source is unreadable', async () => {
    const fetchInsights = vi.fn(async () => ({ step: 6 * 60 * 60 * 1000, values: [] }));
    const history = learnedHistory({
      meterKwhBackfillDone: undefined,
      meterKwhDeviceId: undefined,
      kwhPurgeVersion: undefined,
    });
    const harness = buildHarness(history, { fetchInsights }, { powerSource: undefined });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchInsights).not.toHaveBeenCalled();
    expect(harness.weatherLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_scope_reconcile_deferred',
    }));
    expect(harness.collector.getHistoryStateSnapshot().meterKwhBackfillDone).toBeUndefined();
    harness.stop();
  });

  it('keeps catch-up accumulators intact until a transient scope read recovers', async () => {
    let scopeAvailable = false;
    const getDailyKwh = vi.fn(() => ({ total: 18, controlled: 7, uncontrolled: 11 }));
    const harness = buildHarness(learnedHistory({
      accumulators: {
        '2026-01-09': { sumC: -40, count: 8, minC: -8, maxC: -2, lastHourKey: '23' },
      },
    }), {
      getDailyKwh,
      readMeterScopeSignature: () => (scopeAvailable ? STAMPED_SIGNATURE : undefined),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.collector.getHistoryStateSnapshot().accumulators?.['2026-01-09']).toBeDefined();
    expect(harness.collector.getHistoryStateSnapshot().records).not.toContainEqual(
      expect.objectContaining({ dateKey: '2026-01-09' }),
    );
    expect(getDailyKwh).not.toHaveBeenCalled();

    scopeAvailable = true;
    await vi.advanceTimersByTimeAsync(60_000);

    const recovered = harness.collector.getHistoryStateSnapshot();
    expect(recovered.accumulators?.['2026-01-09']).toBeUndefined();
    expect(recovered.records).toContainEqual(expect.objectContaining({
      dateKey: '2026-01-09',
      kwhTotal: 18,
      kwhControlled: 7,
      kwhUncontrolled: 11,
      quality: expect.objectContaining({ missingKwh: false }),
    }));
    expect(getDailyKwh).toHaveBeenCalledWith('2026-01-09');
    harness.stop();
  });

  it('adopts the current arrangement without forgetting when the history predates the stamp', async () => {
    const harness = buildHarness(learnedHistory({ meterScopeSignature: undefined }));
    // Adoption is persisted on the start edge itself. If it waited for the
    // normal debounce, a crash could leave the old history unstamped and let a
    // later meter/source change be adopted without invalidating it.
    expect(persistedState(harness.homey).meterScopeSignature).toBe(STAMPED_SIGNATURE);
    expect(persistedState(harness.homey).meterKwhBackfillDone).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterKwhBackfillDone).toBe(true);
    expect(memory.latestFit).toBeDefined();
    expect(memory.records[0].kwhTotal).toBe(30);
    expect(memory.meterScopeSignature).toBe(STAMPED_SIGNATURE);
    expect(memory.meterScopeSinceDateKey).toBeUndefined();
    harness.stop();
  });

  it('treats malformed persisted scope markers as unstamped and adopts without forgetting', async () => {
    const harness = buildHarness(learnedHistory({
      meterScopeSignature: 'unknown-scope-format',
      meterScopeSinceDateKey: '2026-19-42',
    }));
    await vi.advanceTimersByTimeAsync(0);

    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterScopeSignature).toBe(STAMPED_SIGNATURE);
    expect(memory.meterScopeSinceDateKey).toBeUndefined();
    expect(memory.meterKwhBackfillDone).toBe(true);
    expect(memory.latestFit).toBeDefined();
    expect(memory.records[0].kwhTotal).toBe(30);
    expect(harness.weatherLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_scope_invalidated',
    }));
    harness.stop();
  });

  it('treats a future persisted scope epoch as unstamped and adopts without forgetting', async () => {
    const harness = buildHarness(learnedHistory({
      meterScopeSinceDateKey: '2026-01-11',
    }));
    await vi.advanceTimersByTimeAsync(0);

    const memory = harness.collector.getHistoryStateSnapshot();
    expect(memory.meterScopeSignature).toBe(STAMPED_SIGNATURE);
    expect(memory.meterScopeSinceDateKey).toBeUndefined();
    expect(memory.meterKwhBackfillDone).toBe(true);
    expect(memory.latestFit).toBeDefined();
    expect(memory.records[0].kwhTotal).toBe(30);
    expect(harness.weatherLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({
      event: 'weather_meter_scope_invalidated',
    }));
    harness.stop();
  });
});
