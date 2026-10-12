import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { createApp, cleanupApps, getStoredPowerTrackerForTests } from '../utils/appTestUtils';
import { resetPowerStatsForUi } from '../../setup/settingsUiAppRuntime';
import { refreshSettingsUiDevices } from '../../setup/settingsUiApi';
import { readPelsHost } from '../../lib/app/pelsHost';
import { SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX } from '../../packages/contracts/src/settingsUiApi';
import { getHourBucketKey } from '../../lib/utils/hourBuckets';

describe('settings UI app runtime helpers', () => {
  it('uses the contract-declared PELS_APP_NOT_READY prefix for boot-window errors', async () => {
    // Runtime code cannot value-import deploy-excluded contract source files,
    // so `settingsUiAppRuntime.ts` duplicates the literal. This test pins both
    // copies together so a future rename of the canonical constant cannot
    // silently break the settings UI retry contract.
    await expect(refreshSettingsUiDevices({ homey: {} as never })).rejects.toThrow(
      new RegExp(`^${SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX} `),
    );
  });

  it('reads the app as the host while it is wired, and nothing while it is not', () => {
    const app = { getSettingsUiManagedDevices: () => [] };

    expect(readPelsHost({ app })).toBe(app);
    expect(readPelsHost({})).toBeNull();
    expect(readPelsHost({ app: undefined })).toBeNull();
    expect(readPelsHost({ app: null })).toBeNull();
  });


  beforeEach(() => {
    resetMockHomey();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
  });

  it('resets power tracker history without keeping stale breakdown buckets', async () => {
    const app = createApp();
    // The reset persists to the userdata store, which the boot step opens.
    app['openUserdata']();
    (app.homey as typeof app.homey & { app?: unknown }).app = app;
    const nowMs = new Date('2026-03-03T10:20:00.000Z').getTime();
    const currentHourKey = getHourBucketKey(nowMs);
    const previousHourKey = getHourBucketKey(nowMs - 3600_000);

    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const appWithPrivates = app as unknown as Record<string, (...args: unknown[]) => unknown>;
    const updateDailyBudgetAndRecordCap = vi.spyOn(appWithPrivates, 'updateDailyBudgetAndRecordCap').mockImplementation(() => {});
    const settingsSet = vi.spyOn(mockHomeyInstance.settings, 'set');

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
      generationBuckets: {
        [previousHourKey]: 1.1,
        [currentHourKey]: 0.7,
      },
      exportBuckets: {
        [previousHourKey]: 0.8,
        [currentHourKey]: 0.4,
      },
      generationDailyTotals: { '2026-03-03': 3.1 },
      exportDailyTotals: { '2026-03-03': 1.9 },
      capacityQuarter: {
        startMs: Date.UTC(2026, 2, 3, 10, 15),
        energyKWh: 0.42,
        trackedMs: 5 * 60 * 1000,
      },
      capacityMonthlyPeak: { monthKey: '2026-03', peakKw: 6.8 },
      unreliablePeriods: [{ start: nowMs - 3_600_000, end: nowMs - 3_000_000 }],
    };

    const result = resetPowerStatsForUi(app);

    expect(result.buckets).toEqual({ [currentHourKey]: 0.5 });
    // Solar history is cleared like every other family (current hour preserved,
    // daily totals emptied) — no stale produced/exported history survives.
    expect(result.generationBuckets).toEqual({ [currentHourKey]: 0.7 });
    expect(result.exportBuckets).toEqual({ [currentHourKey]: 0.4 });
    expect(result.generationDailyTotals).toEqual({});
    expect(result.exportDailyTotals).toEqual({});
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
    expect(result.capacityMonthlyPeak).toBeUndefined();
    expect(result.capacityQuarter).toEqual({
      startMs: Date.UTC(2026, 2, 3, 10, 15),
      energyKWh: 0.42,
      trackedMs: 5 * 60 * 1000,
    });
    expect(result.lastPowerW).toBe(4300);
    expect(result.lastTimestamp).toBe(nowMs - 5_000);
    expect(updateDailyBudgetAndRecordCap).toHaveBeenCalledWith({
      nowMs: nowMs - 5_000,
      forcePlanRebuild: true,
      persistReason: 'manual',
    });
    // The owner's reset is persisted at once, and never through the settings key.
    expect(getStoredPowerTrackerForTests()?.lastPowerW).toBe(4300);
    expect(settingsSet.mock.calls.filter(([key]) => key === 'power_tracker_state')).toHaveLength(0);
  });
});
