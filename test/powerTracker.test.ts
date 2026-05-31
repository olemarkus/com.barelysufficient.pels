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
  aggregateAndPruneHistory,
  recordPowerSample,
} from '../lib/power/tracker';
import {
  getHourBucketKey,
  truncateToUtcHour,
  getDateKeyInTimeZone,
  getZonedParts,
} from '../lib/utils/dateUtils';

// Use fake timers to control throttling, but keep real Date behavior
vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'] });

describe('power tracker integration', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({
      driverA: new MockDriver('driverA', [new MockDevice('dev-1', 'Heater', ['onoff'])]),
    });
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('accumulates kWh from W samples correctly', async () => {
    const app = createApp();
    await app.onInit();

    // Use current time to avoid aggregation pruning (data older than 30 days is aggregated)
    const now = Date.now();
    const start = now - (now % (60 * 60 * 1000)); // Align to hour boundary
    // 1 kW for 30 minutes => 0.5 kWh
    await app['powerSamplePipeline'].recordPowerSample(1000, start);
    await app['powerSamplePipeline'].recordPowerSample(1000, start + 30 * 60 * 1000);

    const bucketKey = getHourBucketKey(start);
    vi.advanceTimersByTime(60000);
    const state = mockHomeyInstance.settings.get('power_tracker_state');
    expect(state.buckets[bucketKey]).toBeCloseTo(0.5, 3);
  });

  it('reloads tracker state when settings change', async () => {
    const app = createApp();
    await app.onInit();

    // Simulate persisted state being cleared via settings UI.
    mockHomeyInstance.settings.set('power_tracker_state', {});

    vi.advanceTimersByTime(10);
    expect(app['powerTracker'].buckets).toBeUndefined();
  });

  it('aggregates old hourly data into daily totals', async () => {
    const app = createApp();
    await app.onInit();

    // Create data that is 35 days old (older than 30-day hourly retention)
    const now = Date.now();
    const oldTimestamp = now - (35 * 24 * 60 * 60 * 1000); // 35 days ago
    const oldHourStart = truncateToUtcHour(oldTimestamp);
    const oldBucketKey = new Date(oldHourStart).toISOString();
    // Mock Homey reports Europe/Oslo, so the runtime now keys dailyTotals and
    // hourlyAverages by the local calendar date / hour (TODO `power-tracker-tz-fix`).
    const oldDateKey = getDateKeyInTimeZone(new Date(oldHourStart), 'Europe/Oslo');
    // formatDateUtc is still exported and used by back-compat callers; keep it imported.
    void formatDateUtc;

    // Manually set old data in powerTracker
    app['powerTracker'] = {
      buckets: {
        [oldBucketKey]: 1.5, // 1.5 kWh
      },
      dailyTotals: {},
      hourlyAverages: {},
    };

    // Call prunePowerTrackerHistory which triggers aggregation
    app['prunePowerTrackerHistory']();

    const state = mockHomeyInstance.settings.get('power_tracker_state');

    // Old hourly bucket should be removed
    expect(state.buckets[oldBucketKey]).toBeUndefined();

    // Should be aggregated into daily totals
    expect(state.dailyTotals[oldDateKey]).toBeCloseTo(1.5, 3);

    // Should be in hourly averages pattern. Weekday is derived from the local date key
    // (date-label weekday is identical whether we parse it as UTC or local midnight).
    // Hour-of-day comes from the Homey-local hour the sample actually fell in.
    const date = new Date(oldHourStart);
    const localHour = getZonedParts(date, 'Europe/Oslo').hour;
    const localDayOfWeek = new Date(`${oldDateKey}T00:00:00.000Z`).getUTCDay();
    const patternKey = `${localDayOfWeek}_${localHour}`;
    void getUtcDayOfWeek;
    void getUtcHour;
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
    const recentHourStart = truncateToUtcHour(recentTimestamp);
    const recentBucketKey = new Date(recentHourStart).toISOString();

    app['powerTracker'] = {
      buckets: {
        [recentBucketKey]: 2.0,
      },
      dailyTotals: {},
      hourlyAverages: {},
    };

    // Pruning shouldn't affect recent buckets
    app['prunePowerTrackerHistory']();

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
    const saveState = vi.fn();
    const rebuildPlanFromCache = vi.fn();
    const nowMs = 1700000000000;

    await recordPowerSample({
      state,
      currentPowerW: 1000,
      nowMs,

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
    const rebuildPlanFromCache = vi.fn();
    const start = Date.UTC(2025, 0, 1, 0, 50, 0);

    await recordPowerSample({
      state,
      currentPowerW: 3600,
      nowMs: start,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    await recordPowerSample({
      state,
      currentPowerW: 3600,
      nowMs: start + 20 * 60 * 1000,

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
    const rebuildPlanFromCache = vi.fn();
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);

    await recordPowerSample({
      state,
      currentPowerW: 1000,
      controlledPowerW: 600,
      nowMs: start,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    await recordPowerSample({
      state,
      currentPowerW: 1000,
      controlledPowerW: 600,
      nowMs: start + 30 * 60 * 1000,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    const bucketKey = new Date(Date.UTC(2025, 0, 1, 0, 0, 0)).toISOString();
    const snapshot = state as any;
    expect(snapshot.controlledBuckets[bucketKey]).toBeCloseTo(0.3, 3);
    expect(snapshot.uncontrolledBuckets[bucketKey]).toBeCloseTo(0.2, 3);
  });

  it('tracks exempt buckets when provided', async () => {
    const state = {};
    const saveState = (nextState: any) => Object.assign(state, nextState);
    const rebuildPlanFromCache = vi.fn();
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);

    await recordPowerSample({
      state,
      currentPowerW: 1000,
      exemptPowerW: 400,
      nowMs: start,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    await recordPowerSample({
      state,
      currentPowerW: 1000,
      exemptPowerW: 400,
      nowMs: start + 30 * 60 * 1000,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    const bucketKey = new Date(Date.UTC(2025, 0, 1, 0, 0, 0)).toISOString();
    const snapshot = state as any;
    expect(snapshot.exemptBuckets[bucketKey]).toBeCloseTo(0.2, 3);
  });

  it('tracks per-device measured buckets when provided on both samples', async () => {
    const state = {};
    const saveState = (nextState: any) => Object.assign(state, nextState);
    const rebuildPlanFromCache = vi.fn();
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);

    await recordPowerSample({
      state,
      currentPowerW: 2000,
      currentDevicePowerWById: { heater: 1200, ev: 0 },
      nowMs: start,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    await recordPowerSample({
      state,
      currentPowerW: 2000,
      currentDevicePowerWById: { heater: 1200, ev: 0 },
      nowMs: start + 30 * 60 * 1000,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    const bucketKey = new Date(Date.UTC(2025, 0, 1, 0, 0, 0)).toISOString();
    const snapshot = state as any;
    expect(snapshot.deviceBuckets.heater[bucketKey]).toBeCloseTo(0.6, 3);
    expect(snapshot.deviceBuckets.ev[bucketKey]).toBe(0);
    expect(snapshot.lastDevicePowerWById).toEqual({ heater: 1200, ev: 0 });
  });

  it('splits per-device measured buckets across hour boundaries', async () => {
    const state = {};
    const saveState = (nextState: any) => Object.assign(state, nextState);
    const rebuildPlanFromCache = vi.fn();
    const start = Date.UTC(2025, 0, 1, 0, 50, 0);

    await recordPowerSample({
      state,
      currentPowerW: 2000,
      currentDevicePowerWById: { heater: 1800 },
      nowMs: start,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    await recordPowerSample({
      state,
      currentPowerW: 2000,
      currentDevicePowerWById: { heater: 1800 },
      nowMs: start + 20 * 60 * 1000,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    const bucket0 = new Date(Date.UTC(2025, 0, 1, 0, 0, 0)).toISOString();
    const bucket1 = new Date(Date.UTC(2025, 0, 1, 1, 0, 0)).toISOString();
    const snapshot = state as any;
    expect(snapshot.deviceBuckets.heater[bucket0]).toBeCloseTo(0.3, 3);
    expect(snapshot.deviceBuckets.heater[bucket1]).toBeCloseTo(0.3, 3);
  });

  it('does not infer per-device buckets when current measured evidence is missing', async () => {
    const state = {};
    const saveState = (nextState: any) => Object.assign(state, nextState);
    const rebuildPlanFromCache = vi.fn();
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);

    await recordPowerSample({
      state,
      currentPowerW: 2000,
      currentDevicePowerWById: { heater: 1200 },
      nowMs: start,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    await recordPowerSample({
      state,
      currentPowerW: 2000,
      currentDevicePowerWById: {},
      nowMs: start + 30 * 60 * 1000,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    const snapshot = state as any;
    expect(snapshot.deviceBuckets?.heater).toBeUndefined();
    expect(snapshot.lastDevicePowerWById).toEqual({});
  });

  it('omits per-device buckets when no measured device energy is retained', async () => {
    const state = {};
    const saveState = (nextState: any) => Object.assign(state, nextState);
    const rebuildPlanFromCache = vi.fn();
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);

    await recordPowerSample({
      state,
      currentPowerW: 2000,
      nowMs: start,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    await recordPowerSample({
      state,
      currentPowerW: 2000,
      nowMs: start + 30 * 60 * 1000,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    expect((state as any).deviceBuckets).toBeUndefined();
  });

  it('prunes old per-device measured buckets', () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2025, 1, 15, 0, 0, 0);
      vi.setSystemTime(now);
      const freshBucket = new Date(now - 2 * 60 * 60 * 1000).toISOString();
      const staleBucket = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const pruned = aggregateAndPruneHistory({
        buckets: { [freshBucket]: 1 },
        deviceBuckets: {
          heater: { [freshBucket]: 0.5, [staleBucket]: 1.2 },
          ev: { [staleBucket]: 2 },
        },
        lastDevicePowerWById: { heater: 1200, ev: 0 },
      });

      expect(pruned.deviceBuckets).toEqual({ heater: { [freshBucket]: 0.5 } });
      expect(pruned.lastDevicePowerWById).toEqual({ heater: 1200, ev: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a boundary day once per weekday/hour slot across two prune runs', () => {
    vi.useFakeTimers();
    try {
      // A single calendar day whose hours age out of the 30-day hourly window across
      // two prune runs must contribute count +1 (not +2) per weekday/hour slot. The
      // old dense 0..23 loop incremented every slot's count on every run, inflating the
      // divisor with zero-sum entries and biasing typical-day averages low.
      const dayStart = Date.UTC(2025, 0, 6, 0, 0, 0); // Monday
      const hour = (h: number) => new Date(dayStart + h * 60 * 60 * 1000).toISOString();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const dayOfWeek = new Date('2025-01-06T00:00:00.000Z').getUTCDay();

      // Run 1: only hours 0 and 1 have aged past the 30-day threshold.
      vi.setSystemTime(dayStart + 2 * 60 * 60 * 1000 + thirtyDaysMs);
      const firstRun = aggregateAndPruneHistory({
        buckets: { [hour(0)]: 1, [hour(1)]: 2, [hour(2)]: 3, [hour(3)]: 4 },
        dailyTotals: {},
        hourlyAverages: {},
      });

      expect(firstRun.hourlyAverages[`${dayOfWeek}_0`]).toEqual({ sum: 1, count: 1 });
      expect(firstRun.hourlyAverages[`${dayOfWeek}_1`]).toEqual({ sum: 2, count: 1 });
      // Hours not yet aged out must not have a count contribution yet.
      expect(firstRun.hourlyAverages[`${dayOfWeek}_2`]).toBeUndefined();

      // Run 2: clock advances so hours 2 and 3 now age out too, fed the persisted state.
      vi.setSystemTime(dayStart + 4 * 60 * 60 * 1000 + thirtyDaysMs);
      const secondRun = aggregateAndPruneHistory({
        buckets: firstRun.buckets,
        dailyTotals: firstRun.dailyTotals,
        hourlyAverages: firstRun.hourlyAverages,
      });

      // Each hour slot contributed exactly once total — no zero-sum double counting.
      expect(secondRun.hourlyAverages[`${dayOfWeek}_0`]).toEqual({ sum: 1, count: 1 });
      expect(secondRun.hourlyAverages[`${dayOfWeek}_1`]).toEqual({ sum: 2, count: 1 });
      expect(secondRun.hourlyAverages[`${dayOfWeek}_2`]).toEqual({ sum: 3, count: 1 });
      expect(secondRun.hourlyAverages[`${dayOfWeek}_3`]).toEqual({ sum: 4, count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits per-device buckets when pruning removes every device bucket', () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2025, 1, 15, 0, 0, 0);
      vi.setSystemTime(now);
      const staleBucket = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

      const pruned = aggregateAndPruneHistory({
        buckets: {},
        deviceBuckets: {
          heater: { [staleBucket]: 1.2 },
          ev: { [staleBucket]: 2 },
        },
      });

      expect(pruned.deviceBuckets).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
