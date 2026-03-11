import { mockHomeyInstance } from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import { resetSettingsUiPowerStatsForApp } from '../lib/app/settingsUiAppRuntime';
import { getHourBucketKey } from '../lib/utils/dateUtils';

describe('settings UI app runtime helpers', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    jest.restoreAllMocks();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.restoreAllMocks();
  });

  it('resets power tracker history without keeping stale breakdown buckets', async () => {
    const app = createApp();
    (app.homey as typeof app.homey & { app?: unknown }).app = app;
    const nowMs = new Date('2026-03-03T10:20:00.000Z').getTime();
    const currentHourKey = getHourBucketKey(nowMs);
    const previousHourKey = getHourBucketKey(nowMs - 3600_000);

    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    const updateDailyBudgetAndRecordCap = jest.spyOn(app as never, 'updateDailyBudgetAndRecordCap').mockImplementation(() => {});
    const persistPowerTrackerState = jest.spyOn(app as never, 'persistPowerTrackerState').mockImplementation(() => {});

    (app as { powerTracker: Record<string, unknown> }).powerTracker = {
      lastPowerW: 4300,
      lastTimestamp: nowMs - 5_000,
      buckets: {
        [previousHourKey]: 1.5,
        [currentHourKey]: 0.5,
      },
      controlledBuckets: {
        [previousHourKey]: 0.6,
        [currentHourKey]: 0.2,
      },
      uncontrolledBuckets: {
        [previousHourKey]: 0.9,
        [currentHourKey]: 0.3,
      },
      exemptBuckets: {
        [previousHourKey]: 0.4,
        [currentHourKey]: 0.1,
      },
      hourlyBudgets: {
        [previousHourKey]: 2.4,
        [currentHourKey]: 2.2,
      },
      dailyBudgetCaps: {
        [previousHourKey]: 1.8,
        [currentHourKey]: 1.6,
      },
      dailyTotals: { '2026-03-03': 2.4 },
      hourlyAverages: { '2_10': { sum: 8, count: 4 } },
      unreliablePeriods: [{ start: nowMs - 3_600_000, end: nowMs - 3_000_000 }],
    };

    const result = await resetSettingsUiPowerStatsForApp(app.homey);

    expect(result.buckets).toEqual({ [currentHourKey]: 0.5 });
    expect(result.controlledBuckets).toEqual({ [currentHourKey]: 0.2 });
    expect(result.uncontrolledBuckets).toEqual({ [currentHourKey]: 0.3 });
    expect(result.exemptBuckets).toEqual({ [currentHourKey]: 0.1 });
    expect(result.hourlyBudgets).toEqual({ [currentHourKey]: 2.2 });
    expect(result.dailyBudgetCaps).toEqual({});
    expect(result.dailyTotals).toEqual({});
    expect(result.hourlyAverages).toEqual({});
    expect(result.exemptDailyTotals).toEqual({});
    expect(result.exemptHourlyAverages).toEqual({});
    expect(result.unreliablePeriods).toEqual([]);
    expect(result.lastPowerW).toBe(4300);
    expect(result.lastTimestamp).toBe(nowMs - 5_000);
    expect(updateDailyBudgetAndRecordCap).toHaveBeenCalledWith({
      nowMs: nowMs - 5_000,
      forcePlanRebuild: true,
    });
    expect(persistPowerTrackerState).toHaveBeenCalledTimes(1);
  });
});
