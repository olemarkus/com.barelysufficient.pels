import type Homey from 'homey';
import type { Logger as PinoLogger } from 'pino';
import { MockSettings } from '../mocks/homey';
import { createWeatherHistoryStore } from '../../setup/weatherHistoryStateAdapter';
import { WeatherCollector } from '../../lib/weather/weatherCollector';
import { buildWeatherAdvisorSettings } from '../../lib/weather/weatherSettings';
import { WEATHER_ADVISOR_SETTINGS, WEATHER_HISTORY_STATE } from '../../lib/utils/settingsKeys';
import type { WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';

// Integration seam: real settings adapter + real collector over the mock
// Homey settings store — only the device transport and Insights reads are
// stubbed at the outward seam.

const OSLO = 'Europe/Oslo';
const START_MS = Date.UTC(2026, 0, 10, 10, 0, 0);

const buildCollector = (homey: { settings: MockSettings }) => new WeatherCollector({
  store: createWeatherHistoryStore(homey as unknown as Homey.App['homey']),
  readDevice: async () => ({
    id: 'out-1',
    name: 'Outdoor',
    capabilitiesObj: { measure_temperature: { value: -3.5 } },
  }),
  fetchInsights: async () => ({ step: 6 * 60 * 60 * 1000, values: [] }),
  getDailyKwh: () => ({ total: 18 }),
  getUnreliablePeriods: () => [],
  getSettings: () => buildWeatherAdvisorSettings({ settings: homey.settings }),
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
    expect(homey.settings.get(WEATHER_HISTORY_STATE)).toBeUndefined();
  });
});
