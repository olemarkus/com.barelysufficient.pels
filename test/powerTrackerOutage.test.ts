import {
    recordPowerSample,
    PowerTrackerState,
} from '../lib/core/powerTracker';

// Mock dependencies
const mockHomey = {
    clock: {
        getTimezone: jest.fn().mockReturnValue('UTC'),
    },
} as any;

const mockRebuildPlan = jest.fn().mockResolvedValue(undefined);
const mockSaveState = jest.fn();

describe('PowerTracker Outage Tracking', () => {
    let state: PowerTrackerState;
    const now = new Date('2025-01-01T12:00:00Z').getTime();

    beforeEach(() => {
        state = {
            lastPowerW: 1000,
            lastTimestamp: now,
            buckets: {},
            hourlyBudgets: {},
            dailyTotals: {},
            hourlyAverages: {},
            unreliablePeriods: [],
        };
        jest.clearAllMocks();
    });

    test('should not record outage for short gaps within same hour', async () => {
        // 07:15 -> 07:45 (30 min gap, same hour)
        const time1 = new Date('2025-01-01T07:15:00Z').getTime();
        const time2 = new Date('2025-01-01T07:45:00Z').getTime();

        state.lastTimestamp = time1;
        state.lastPowerW = 1000;

        await recordPowerSample({
            state,
            currentPowerW: 1200,
            nowMs: time2,
            homey: mockHomey,
            rebuildPlanFromCache: mockRebuildPlan,
            saveState: mockSaveState,
        });

        const savedState = mockSaveState.mock.calls[0][0];
        expect(savedState.unreliablePeriods).toEqual([]);
    });

    test('should record outage for gaps > 1 hour', async () => {
        const gapMs = 2 * 60 * 60 * 1000; // 2 hours
        const nextTime = now + gapMs;

        await recordPowerSample({
            state,
            currentPowerW: 1200,
            nowMs: nextTime,
            homey: mockHomey,
            rebuildPlanFromCache: mockRebuildPlan,
            saveState: mockSaveState,
        });

        const savedState = mockSaveState.mock.calls[0][0];
        expect(savedState.unreliablePeriods).toHaveLength(1);
        expect(savedState.unreliablePeriods[0]).toEqual({
            start: now,
            end: nextTime,
        });
    });

    test('should accumulate unreliable periods', async () => {
        // First outage
        const time1 = now + 2 * 3600 * 1000;
        await recordPowerSample({
            state,
            currentPowerW: 1200,
            nowMs: time1,
            homey: mockHomey,
            rebuildPlanFromCache: mockRebuildPlan,
            saveState: mockSaveState,
        });

        let savedState = mockSaveState.mock.calls[0][0];

        // Normal update
        const time2 = time1 + 10 * 60 * 1000;
        await recordPowerSample({
            state: savedState,
            currentPowerW: 1300,
            nowMs: time2,
            homey: mockHomey,
            rebuildPlanFromCache: mockRebuildPlan,
            saveState: mockSaveState,
        });

        savedState = mockSaveState.mock.calls[1][0];

        // Second outage
        const time3 = time2 + 3 * 3600 * 1000;
        await recordPowerSample({
            state: savedState,
            currentPowerW: 1400,
            nowMs: time3,
            homey: mockHomey,
            rebuildPlanFromCache: mockRebuildPlan,
            saveState: mockSaveState,
        });

        const finalState = mockSaveState.mock.calls[2][0];
        expect(finalState.unreliablePeriods).toHaveLength(2);
        expect(finalState.unreliablePeriods[0]).toEqual({ start: now, end: time1 });
        expect(finalState.unreliablePeriods[1]).toEqual({ start: time2, end: time3 });
    });

    test('should record outage for gap > 1 min crossing hour boundary', async () => {
        // 07:59 -> 08:01 (2 min gap)
        const time1 = new Date('2025-01-01T07:59:00Z').getTime();
        const time2 = new Date('2025-01-01T08:01:00Z').getTime();

        // Set initial state
        state.lastTimestamp = time1;
        state.lastPowerW = 1000;

        await recordPowerSample({
            state,
            currentPowerW: 1000,
            nowMs: time2,
            homey: mockHomey,
            rebuildPlanFromCache: mockRebuildPlan,
            saveState: mockSaveState,
        });

        const savedState = mockSaveState.mock.calls[0][0];
        expect(savedState.unreliablePeriods).toHaveLength(1);
        expect(savedState.unreliablePeriods[0]).toEqual({ start: time1, end: time2 });
    });

    test('should NOT record outage for gap < 1 min crossing hour boundary', async () => {
        // 07:59:30 -> 08:00:10 (40 sec gap)
        const time1 = new Date('2025-01-01T07:59:30Z').getTime();
        const time2 = new Date('2025-01-01T08:00:10Z').getTime();

        state.lastTimestamp = time1;
        state.lastPowerW = 1000;

        await recordPowerSample({
            state,
            currentPowerW: 1000,
            nowMs: time2,
            homey: mockHomey,
            rebuildPlanFromCache: mockRebuildPlan,
            saveState: mockSaveState,
        });

        const savedState = mockSaveState.mock.calls[0][0];
        expect(savedState.unreliablePeriods).toEqual([]);
    });

    test('should NOT record outage for gap > 1 min within same hour', async () => {
        // 07:10 -> 07:20 (10 min gap)
        const time1 = new Date('2025-01-01T07:10:00Z').getTime();
        const time2 = new Date('2025-01-01T07:20:00Z').getTime();

        state.lastTimestamp = time1;
        state.lastPowerW = 1000;

        await recordPowerSample({
            state,
            currentPowerW: 1000,
            nowMs: time2,
            homey: mockHomey,
            rebuildPlanFromCache: mockRebuildPlan,
            saveState: mockSaveState,
        });

        const savedState = mockSaveState.mock.calls[0][0];
        expect(savedState.unreliablePeriods).toEqual([]);
    });
});
