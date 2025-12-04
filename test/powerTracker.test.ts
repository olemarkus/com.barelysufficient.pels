import {
  mockHomeyInstance,
  MockDevice,
  MockDriver,
  setMockDrivers,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate', 'Date'] });

describe('power tracker integration', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({
      driverA: new MockDriver('driverA', [new MockDevice('dev-1', 'Heater', ['onoff'])]),
    });
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
  });

  it('accumulates kWh from W samples correctly', async () => {
    const app = createApp();
    await app.onInit();

    // Use current time to avoid aggregation pruning (data older than 30 days is aggregated)
    const now = Date.now();
    const start = now - (now % (60 * 60 * 1000)); // Align to hour boundary
    // 1 kW for 30 minutes => 0.5 kWh
    await app['recordPowerSample'](1000, start);
    await app['recordPowerSample'](1000, start + 30 * 60 * 1000);

    const bucketKey = new Date(app['truncateToHour'](start)).toISOString();
    const state = mockHomeyInstance.settings.get('power_tracker_state');
    expect(state.buckets[bucketKey]).toBeCloseTo(0.5, 3);
  });

  it('reloads tracker state when settings change', async () => {
    const app = createApp();
    await app.onInit();

    // Simulate persisted state being cleared via settings UI.
    mockHomeyInstance.settings.set('power_tracker_state', {});

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app['powerTracker'].buckets).toBeUndefined();
  });

  it('aggregates old hourly data into daily totals', async () => {
    const app = createApp();
    await app.onInit();

    // Create data that is 35 days old (older than 30-day hourly retention)
    const now = Date.now();
    const oldTimestamp = now - (35 * 24 * 60 * 60 * 1000); // 35 days ago
    const oldHourStart = oldTimestamp - (oldTimestamp % (60 * 60 * 1000));
    const oldBucketKey = new Date(oldHourStart).toISOString();
    const oldDateKey = new Date(oldHourStart).toISOString().slice(0, 10);

    // Manually set old data in powerTracker
    app['powerTracker'] = {
      buckets: {
        [oldBucketKey]: 1.5, // 1.5 kWh
      },
      dailyTotals: {},
      hourlyAverages: {},
    };

    // Call savePowerTracker which triggers aggregation
    app['savePowerTracker']();

    const state = mockHomeyInstance.settings.get('power_tracker_state');

    // Old hourly bucket should be removed
    expect(state.buckets[oldBucketKey]).toBeUndefined();

    // Should be aggregated into daily totals
    expect(state.dailyTotals[oldDateKey]).toBeCloseTo(1.5, 3);

    // Should be in hourly averages pattern
    const date = new Date(oldHourStart);
    const patternKey = `${date.getDay()}_${date.getHours()}`;
    expect(state.hourlyAverages[patternKey]).toBeDefined();
    expect(state.hourlyAverages[patternKey].sum).toBeCloseTo(1.5, 3);
    expect(state.hourlyAverages[patternKey].count).toBe(1);
  });

  it('keeps recent hourly data without aggregation', async () => {
    const app = createApp();
    await app.onInit();

    // Create data that is 5 days old (within 30-day retention)
    const now = Date.now();
    const recentTimestamp = now - (5 * 24 * 60 * 60 * 1000); // 5 days ago
    const recentHourStart = recentTimestamp - (recentTimestamp % (60 * 60 * 1000));
    const recentBucketKey = new Date(recentHourStart).toISOString();

    app['powerTracker'] = {
      buckets: {
        [recentBucketKey]: 2.0,
      },
      dailyTotals: {},
      hourlyAverages: {},
    };

    app['savePowerTracker']();

    const state = mockHomeyInstance.settings.get('power_tracker_state');

    // Recent hourly bucket should still exist
    expect(state.buckets[recentBucketKey]).toBeCloseTo(2.0, 3);
  });
});
