import type { Logger as PinoLogger } from 'pino';
import { MockSettings } from '../mocks/homey';
import { createWeatherHistoryStore, type WeatherHistoryStore } from '../../lib/weather/weatherHistoryStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { normalizeWeatherHistoryState } from '../../lib/weather/weatherHistory';
import { WEATHER_ADVISOR_SETTINGS } from '../../lib/utils/settingsKeys';
import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';

// Integration seam: the real store over an in-memory userdata database + the
// real collector over the mock Homey settings — only the device transport
// and Insights reads are stubbed at the outward seam.

const OSLO = 'Europe/Oslo';
const START_MS = Date.UTC(2026, 0, 10, 10, 0, 0);

const freshStore = (): WeatherHistoryStore => createWeatherHistoryStore(openUserdataDatabase(IN_MEMORY_DATABASE));

const buildCollector = (
  homey: { settings: MockSettings },
  store: WeatherHistoryStore,
  meterScopeSignature?: string,
) => new WeatherCollector({
  store,
  readDevice: async () => ({
    id: 'out-1',
    name: 'Outdoor',
    capabilitiesObj: { measure_temperature: { value: -3.5 } },
  }),
  fetchInsights: async () => ({ step: 6 * 60 * 60 * 1000, values: [] }),
  getDailyKwh: () => ({ total: 18 }),
  isManagedDevice: () => false,
  getUnreliablePeriods: () => [],
  getDaySuppression: () => ({}),
  getAppliedDailyBudgetKwh: () => 50,
  getSettings: () => buildWeatherAdvisorSettings({ settings: homey.settings }),
  readMeterScopeSignature: () => meterScopeSignature,
  readMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: 'meter-main' }),
  readPowerSource: () => ({ state: 'resolved', value: 'homey_energy' }),
  getNowMs: () => Date.now(),
  getTimeZone: () => OSLO,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger,
});

describe('weather history persistence through the userdata store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('survives a collector restart: state written on stop is adopted on the next start', async () => {
    const homey = { settings: new MockSettings() };
    homey.settings.set(WEATHER_ADVISOR_SETTINGS, { enabled: true, outdoorDeviceId: 'out-1' });

    const store = freshStore();
    const first = buildCollector(homey, store);
    first.start();
    // A truly fresh install has no persisted history, so the abandon-grace
    // window holds the first write back for five minutes; the first retry
    // after expiry lands it.
    await vi.advanceTimersByTimeAsync(331_000);
    first.stop();

    const persisted = store.read() as WeatherHistoryState;
    expect(persisted.accumulators?.['2026-01-10']).toMatchObject({ count: 1, minC: -3.5 });
    // Empty Insights history ⇒ the one-shot backfill marker stays unset.
    expect(persisted.backfilledDeviceId).toBeUndefined();

    // Same local hour after restart: the re-sample must dedupe against the
    // persisted accumulator instead of double-counting.
    const second = buildCollector(homey, store);
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    second.stop();
    const afterRestart = store.read() as WeatherHistoryState;
    expect(afterRestart.accumulators?.['2026-01-10']?.count).toBe(1);
  });

  it('does nothing when the feature flag is absent', async () => {
    const homey = { settings: new MockSettings() };
    const store = freshStore();
    const collector = buildCollector(homey, store);
    collector.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    collector.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(store.read()).toBeNull();
  });

  it('re-forgets recovered old-scope state before persisting it', async () => {
    const homey = { settings: new MockSettings() };
    homey.settings.set(WEATHER_ADVISOR_SETTINGS, { enabled: true, outdoorDeviceId: 'out-1' });
    const staleRecord = {
      dateKey: '2025-03-01',
      kwhTotal: 55,
      tempMeanC: -2,
      tempMinC: -6,
      tempMaxC: 1,
      tempSampleCount: 24,
      quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
    };
    const store = freshStore();
    store.write({
      records: [staleRecord],
      backfilledDeviceId: 'out-1',
      backfillVersion: 2,
      meterKwhBackfillDone: true,
      meterKwhDeviceId: 'meter-old',
      kwhPurgeVersion: 1,
      controlledBackfillVersion: 2,
      meterScopeSignature: 'source:homey_energy|main:meter-old',
    });
    // The boot read fails once (I/O); the collector's grace re-read recovers it.
    const originalRead = store.read.bind(store);
    let historyReads = 0;
    vi.spyOn(store, 'read').mockImplementation(() => {
      if (historyReads++ === 0) throw new Error('disk busy');
      return originalRead();
    });

    const collector = buildCollector(homey, store, 'source:flow');
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);

    const persisted = originalRead() as WeatherHistoryState;
    expect(persisted.meterKwhBackfillDone).toBeUndefined();
    expect(persisted.meterKwhDeviceId).toBeUndefined();
    expect(persisted.kwhPurgeVersion).toBeUndefined();
    expect(persisted.controlledBackfillVersion).toBeUndefined();
    expect(persisted.meterScopeSignature).toBe('source:flow');
    expect(persisted.meterScopeSinceDateKey).toBe('2026-01-10');
    expect(persisted.records[0].kwhTotal).toBeUndefined();
    expect(persisted.records[0]).toMatchObject({
      tempMeanC: -2,
      quality: { missingKwh: true },
    });
    collector.stop();
  });

  // An unreadable store is not an empty one: the grace window may expire on
  // an affirmative empty, never on a read that keeps throwing — the empty
  // in-memory state diffed against rows it never saw would delete them.
  it('never writes while the store stays unreadable past the grace window, and recovers once it answers', async () => {
    const homey = { settings: new MockSettings() };
    homey.settings.set(WEATHER_ADVISOR_SETTINGS, { enabled: true, outdoorDeviceId: 'out-1' });
    const store = freshStore();
    store.write({ records: [{
      dateKey: '2025-03-01', tempMeanC: -2, tempMinC: -6, tempMaxC: 1, tempSampleCount: 24,
      quality: { partialTemp: false, missingKwh: true, unreliablePower: false, backfilled: false },
    }] });
    const originalRead = store.read.bind(store);
    let unreadable = true;
    vi.spyOn(store, 'read').mockImplementation(() => {
      if (unreadable) throw new Error('disk busy');
      return originalRead();
    });
    const write = vi.spyOn(store, 'write');

    const collector = buildCollector(homey, store);
    collector.start();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(write).not.toHaveBeenCalled();

    unreadable = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(write).toHaveBeenCalled();
    const persisted = originalRead() as WeatherHistoryState;
    expect(persisted.records.map((record) => record.dateKey)).toContain('2025-03-01');
    expect(persisted.accumulators?.['2026-01-10']).toBeDefined();
    collector.stop();
  });

  it('round-trips the budget-pressure term and the applied budget through persistence', () => {
    // Both are new persisted fields. A key drift or an over-strict reject in
    // `normalizeBudgetPressure` would silently reset the integrator on every
    // restart — Homey restarts often — so the loop could never reach a
    // multi-day term in production while every suite stayed green.
    const persisted = {
      records: [{
        dateKey: '2026-07-31',
        kwhTotal: 50,
        tempMeanC: 12.8,
        tempMinC: 11.1,
        tempMaxC: 15.7,
        tempSampleCount: 24,
        quality: {
          partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false,
        },
        appliedBudgetKwh: 44,
        suppression: { blockedByHeadroomMs: 6 * 60 * 60 * 1000 },
      }],
      budgetPressure: { kwh: 13.9, throughDateKey: '2026-07-31' },
    };
    const store = freshStore();
    store.write(persisted as unknown as WeatherHistoryState);
    const normalized = normalizeWeatherHistoryState(store.read());
    expect(normalized?.budgetPressure).toEqual({ kwh: 13.9, throughDateKey: '2026-07-31' });
    expect(normalized?.records[0].appliedBudgetKwh).toBe(44);
    expect(normalized?.records[0].suppression?.blockedByHeadroomMs).toBe(6 * 60 * 60 * 1000);
  });

  it('drops a half-written budget-pressure term rather than trusting it', () => {
    // It is added straight onto a persisted budget, so a malformed value must
    // restart the loop at zero rather than propagate.
    const roundTrip = (budgetPressure: unknown) => {
      const store = freshStore();
      store.write({ records: [], budgetPressure } as unknown as WeatherHistoryState);
      return normalizeWeatherHistoryState(store.read())?.budgetPressure;
    };
    expect(roundTrip({ kwh: 5 })).toBeUndefined();
    expect(roundTrip({ throughDateKey: 'd' })).toBeUndefined();
    expect(roundTrip({ kwh: -1, throughDateKey: 'd' })).toBeUndefined();
    expect(roundTrip({ kwh: Number.NaN, throughDateKey: 'd' })).toBeUndefined();
  });
});
