import {
  mockHomeyInstance,
  MockDevice,
  MockDriver,
  setMockDrivers,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import {
  formatDateUtc,
  getUtcDayOfWeek,
  getUtcHour,
  recordPowerSample,
} from '../lib/core/powerTracker';
import { getHourStartInTimeZone } from '../lib/utils/dateUtils';

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

    const bucketKey = new Date(getHourStartInTimeZone(new Date(start), mockHomeyInstance.clock.getTimezone())).toISOString();
    const state = mockHomeyInstance.settings.get('power_tracker_state');
    expect(state.buckets[bucketKey]).toBeCloseTo(0.5, 3);
  });

  it('reloads tracker state when settings change', async () => {
    const app = createApp();
    await app.onInit();

    // Simulate persisted state being cleared via settings UI.
    mockHomeyInstance.settings.set('power_tracker_state', {});

    await Promise.resolve();
    expect(app['powerTracker'].buckets).toBeUndefined();
  });

  it('aggregates old hourly data into daily totals', async () => {
    const app = createApp();
    await app.onInit();

    // Create data that is 35 days old (older than 30-day hourly retention)
    const now = Date.now();
    const oldTimestamp = now - (35 * 24 * 60 * 60 * 1000); // 35 days ago
    const oldHourStart = getHourStartInTimeZone(new Date(oldTimestamp), mockHomeyInstance.clock.getTimezone());
    const oldBucketKey = new Date(oldHourStart).toISOString();
    const oldDateKey = formatDateUtc(new Date(oldHourStart));

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
    const patternKey = `${getUtcDayOfWeek(date)}_${getUtcHour(date)}`;
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

  it('resets sampling when lastTimestamp looks like seconds', async () => {
    const state = {
      lastTimestamp: 1700000000,
      lastPowerW: 500,
      buckets: {},
    };
    const saveState = jest.fn();
    const rebuildPlanFromCache = jest.fn();
    const nowMs = 1700000000000;

    await recordPowerSample({
      state,
      currentPowerW: 1000,
      nowMs,
      homey: mockHomeyInstance as any,
      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    expect(saveState).toHaveBeenCalledTimes(1);
    const saved = saveState.mock.calls[0][0];
    expect(saved.lastTimestamp).toBe(nowMs);
    expect(saved.lastPowerW).toBe(1000);
    expect(saved.buckets).toEqual({});
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
  });

  it('splits energy across hour boundary when samples are delayed', async () => {
    const state = {};
    const saveState = (nextState: any) => Object.assign(state, nextState);
    const rebuildPlanFromCache = jest.fn();
    const start = Date.UTC(2025, 0, 1, 0, 50, 0);

    await recordPowerSample({
      state,
      currentPowerW: 3600,
      nowMs: start,
      homey: mockHomeyInstance as any,
      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    await recordPowerSample({
      state,
      currentPowerW: 3600,
      nowMs: start + 20 * 60 * 1000,
      homey: mockHomeyInstance as any,
      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    const bucket0 = new Date(Date.UTC(2025, 0, 1, 0, 0, 0)).toISOString();
    const bucket1 = new Date(Date.UTC(2025, 0, 1, 1, 0, 0)).toISOString();
    const snapshot = state as any;
    expect(snapshot.buckets[bucket0]).toBeCloseTo(0.6, 3);
    expect(snapshot.buckets[bucket1]).toBeCloseTo(0.6, 3);
  });

  it('tracks controlled and uncontrolled buckets when provided', async () => {
    const state = {};
    const saveState = (nextState: any) => Object.assign(state, nextState);
    const rebuildPlanFromCache = jest.fn();
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);

    await recordPowerSample({
      state,
      currentPowerW: 1000,
      controlledPowerW: 600,
      nowMs: start,
      homey: mockHomeyInstance as any,
      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    await recordPowerSample({
      state,
      currentPowerW: 1000,
      controlledPowerW: 600,
      nowMs: start + 30 * 60 * 1000,
      homey: mockHomeyInstance as any,
      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    const bucketKey = new Date(Date.UTC(2025, 0, 1, 0, 0, 0)).toISOString();
    const snapshot = state as any;
    expect(snapshot.controlledBuckets[bucketKey]).toBeCloseTo(0.3, 3);
    expect(snapshot.uncontrolledBuckets[bucketKey]).toBeCloseTo(0.2, 3);
  });
});
