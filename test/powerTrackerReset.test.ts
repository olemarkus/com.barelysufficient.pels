import { PowerTrackerState } from '../lib/core/powerTracker';
import { getHourBucketKey } from '../lib/utils/dateUtils';

// Replicating the logic we plan to use in the frontend
function getResetState(state: PowerTrackerState, nowMs: number): PowerTrackerState {
    const currentHourKey = getHourBucketKey(nowMs);

    const newBuckets: Record<string, number> = {};
    if (state.buckets && state.buckets[currentHourKey] !== undefined) {
        newBuckets[currentHourKey] = state.buckets[currentHourKey];
    }

    const newBudgets: Record<string, number> = {};
    if (state.hourlyBudgets && state.hourlyBudgets[currentHourKey] !== undefined) {
        newBudgets[currentHourKey] = state.hourlyBudgets[currentHourKey];
    }

    return {
        ...state,
        buckets: newBuckets,
        hourlyBudgets: newBudgets,
        dailyTotals: {},
        hourlyAverages: {},
        unreliablePeriods: [],
        // We preserve lastPowerW and lastTimestamp to ensure the next sample
        // can define a valid duration from the previous one.
    };
}

describe('Reset Logic', () => {
    test('should clear history but keep current hour data', () => {
        const now = new Date('2025-01-01T12:30:00Z').getTime();
        const currentHourKey = '2025-01-01T12:00:00.000Z';
        const pastHourKey = '2025-01-01T11:00:00.000Z';

        const state: PowerTrackerState = {
            lastPowerW: 500,
            lastTimestamp: now - 1000,
            buckets: {
                [pastHourKey]: 1.5,
                [currentHourKey]: 0.5,
            },
            hourlyBudgets: {
                [pastHourKey]: 2.0,
                [currentHourKey]: 2.0,
            },
            dailyTotals: { '2025-01-01': 2.0 },
            hourlyAverages: { '1_12': { sum: 10, count: 5 } },
            unreliablePeriods: [{ start: now - 3600000, end: now - 3500000 }],
        };

        const newState = getResetState(state, now);

        expect(newState.buckets).toEqual({ [currentHourKey]: 0.5 });
        expect(newState.hourlyBudgets).toEqual({ [currentHourKey]: 2.0 });
        expect(newState.dailyTotals).toEqual({});
        expect(newState.hourlyAverages).toEqual({});
        expect(newState.unreliablePeriods).toEqual([]);
        expect(newState.lastPowerW).toBe(500);
        expect(newState.lastTimestamp).toBe(state.lastTimestamp);
    });
});
