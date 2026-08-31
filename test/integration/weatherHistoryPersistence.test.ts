import type Homey from 'homey';
import type { Logger as PinoLogger } from 'pino';
import { MockSettings } from '../mocks/homey';
import { createWeatherHistoryStore } from '../../setup/weatherHistoryStateAdapter';
import { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { normalizeWeatherHistoryState } from '../../lib/weather/weatherHistory';
import { WEATHER_ADVISOR_SETTINGS, WEATHER_HISTORY_STATE } from '../../lib/utils/settingsKeys';
import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';

// Integration seam: real settings adapter + real collector over the mock
// Homey settings store — only the device transport and Insights reads are
// stubbed at the outward seam.

const OSLO = 'Europe/Oslo';
const START_MS = Date.UTC(2026, 0, 10, 10, 0, 0);

const buildCollector = (
  homey: { settings: MockSettings },
  meterScopeSignature?: string,
) => new WeatherCollector({
  store: createWeatherHistoryStore(homey as unknown as Homey.App['homey']),
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

describe('weather history persistence through homey.settings', () => {
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

    const first = buildCollector(homey);
    first.start();
    // A truly fresh install has no persisted blob, so the abandon-grace
    // window holds the first write back for five minutes; the first retry
    // after expiry lands it.
    await vi.advanceTimersByTimeAsync(331_000);
    first.stop();

    const persisted = homey.settings.get(WEATHER_HISTORY_STATE) as WeatherHistoryState;
    expect(persisted.accumulators?.['2026-01-10']).toMatchObject({ count: 1, minC: -3.5 });
    // Empty Insights history ⇒ the one-shot backfill marker stays unset.
    expect(persisted.backfilledDeviceId).toBeUndefined();

    // Same local hour after restart: the re-sample must dedupe against the
    // persisted accumulator instead of double-counting.
    const second = buildCollector(homey);
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    second.stop();
    const afterRestart = homey.settings.get(WEATHER_HISTORY_STATE) as WeatherHistoryState;
    expect(afterRestart.accumulators?.['2026-01-10']?.count).toBe(1);
  });

  it('does nothing when the feature flag is absent', async () => {
    const homey = { settings: new MockSettings() };
    const collector = buildCollector(homey);
    collector.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    collector.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(homey.settings.getKeys()).not.toContain(WEATHER_HISTORY_STATE);
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
    homey.settings.set(WEATHER_HISTORY_STATE, {
      records: [staleRecord],
      backfilledDeviceId: 'out-1',
      backfillVersion: 2,
      meterKwhBackfillDone: true,
      meterKwhDeviceId: 'meter-old',
      kwhPurgeVersion: 1,
      controlledBackfillVersion: 2,
      meterScopeSignature: 'source:homey_energy|main:meter-old',
    });
    const originalGet = homey.settings.get.bind(homey.settings);
    let historyReads = 0;
    vi.spyOn(homey.settings, 'get').mockImplementation((key: string) => {
      if (key === WEATHER_HISTORY_STATE && historyReads++ === 0) return undefined;
      return originalGet(key);
    });

    const collector = buildCollector(homey, 'source:flow');
    collector.start();
    await vi.advanceTimersByTimeAsync(30_000);

    const persisted = originalGet(WEATHER_HISTORY_STATE) as WeatherHistoryState;
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
    const homey = { settings: new MockSettings() };
    homey.settings.set(WEATHER_HISTORY_STATE, persisted);
    const normalized = normalizeWeatherHistoryState(
      createWeatherHistoryStore(homey as unknown as Homey.App['homey']).read(),
    );
    expect(normalized?.budgetPressure).toEqual({ kwh: 13.9, throughDateKey: '2026-07-31' });
    expect(normalized?.records[0].appliedBudgetKwh).toBe(44);
    expect(normalized?.records[0].suppression?.blockedByHeadroomMs).toBe(6 * 60 * 60 * 1000);
  });

  it('drops a half-written budget-pressure term rather than trusting it', () => {
    // It is added straight onto a persisted budget, so a malformed value must
    // restart the loop at zero rather than propagate.
    const roundTrip = (budgetPressure: unknown) => {
      const homey = { settings: new MockSettings() };
      homey.settings.set(WEATHER_HISTORY_STATE, { records: [], budgetPressure });
      return normalizeWeatherHistoryState(
        createWeatherHistoryStore(homey as unknown as Homey.App['homey']).read(),
      )?.budgetPressure;
    };
    expect(roundTrip({ kwh: 5 })).toBeUndefined();
    expect(roundTrip({ throughDateKey: 'd' })).toBeUndefined();
    expect(roundTrip({ kwh: -1, throughDateKey: 'd' })).toBeUndefined();
    expect(roundTrip({ kwh: Number.NaN, throughDateKey: 'd' })).toBeUndefined();
  });
});
