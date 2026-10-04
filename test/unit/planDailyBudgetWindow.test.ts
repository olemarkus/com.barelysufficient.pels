import {
  getHourUsageSplit,
  resolveDailySoftLimitBucket,
  resolveHourlyUsageSplit,
} from '../../lib/plan/planDailyBudgetWindow';
import type { DailyBudgetUiPayload } from '../../packages/contracts/src/dailyBudgetTypes';

describe('plan daily budget current-hour usage split', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:35:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses both gross split buckets directly when present (managed+background reflect actual consumption)', () => {
    const result = resolveHourlyUsageSplit({
      totalRaw: 1.8,
      controlledRaw: 0.6,
      uncontrolledRaw: 0.15,
    });

    // Gross attribution: managed (0.6) + background (0.15) are used as-is and are NOT
    // re-derived from the net total (so they may sum to less/more than the net under solar).
    expect(result.totalKWh).toBe(1.8);
    expect(result.controlledKWh).toBe(0.6);
    expect(result.uncontrolledKWh).toBe(0.15);
  });

  it('uses raw uncontrolled only when controlled data is missing', () => {
    const result = resolveHourlyUsageSplit({
      totalRaw: 1.8,
      controlledRaw: undefined,
      uncontrolledRaw: 0.15,
    });

    expect(result.totalKWh).toBe(1.8);
    expect(result.controlledKWh).toBeCloseTo(1.65, 6);
    expect(result.uncontrolledKWh).toBe(0.15);
  });

  it('preserves legacy split display when total usage is missing but split buckets exist', () => {
    expect(resolveHourlyUsageSplit({
      totalRaw: undefined,
      controlledRaw: 0.6,
      uncontrolledRaw: 0.15,
    })).toEqual({
      controlledKWh: 0.6,
      uncontrolledKWh: 0.15,
    });

    expect(resolveHourlyUsageSplit({
      totalRaw: undefined,
      controlledRaw: 0.6,
      uncontrolledRaw: undefined,
    })).toEqual({
      controlledKWh: 0.6,
      uncontrolledKWh: undefined,
    });

    expect(resolveHourlyUsageSplit({
      totalRaw: undefined,
      controlledRaw: undefined,
      uncontrolledRaw: 0.15,
    })).toEqual({
      controlledKWh: undefined,
      uncontrolledKWh: 0.15,
    });
  });

  it('reads the requested UTC hour from the power tracker', () => {
    const currentHourKey = '2026-04-29T10:00:00.000Z';

    expect(getHourUsageSplit({
      buckets: {
        [currentHourKey]: 2.4,
      },
      controlledBuckets: {
        [currentHourKey]: 1.1,
      },
      uncontrolledBuckets: {
        [currentHourKey]: 0.2,
      },
    }, currentHourKey)).toEqual({
      totalKWh: 2.4,
      controlledKWh: 1.1,
      uncontrolledKWh: 0.2,
    });
  });
});

// A rebuild no reading drove runs against the snapshot the last reading
// computed. At the start of a new hour that snapshot still names the hour just
// ended, and pacing the new hour from its leftover would shed for nothing.
describe('resolveDailySoftLimitBucket', () => {
  const HOUR_MS = 3_600_000;
  const DAY_START_MS = Date.parse('2026-10-24T22:00:00.000Z');
  const hourStart = (index: number) => new Date(DAY_START_MS + index * HOUR_MS).toISOString();
  const snapshotAtHour = (currentBucketIndex: number): DailyBudgetUiPayload => {
    const zeros = Array.from({ length: 24 }, () => 0);
    return {
      todayKey: '2026-10-25',
      days: {
        '2026-10-25': {
          dateKey: '2026-10-25',
          timeZone: 'Europe/Oslo',
          nowUtc: hourStart(currentBucketIndex),
          dayStartUtc: hourStart(0),
          currentBucketIndex,
          budget: { enabled: true, dailyBudgetKWh: 24, priceShapingEnabled: false },
          state: {
            usedNowKWh: 0,
            allowedNowKWh: 0,
            remainingKWh: 24,
            deviationKWh: 0,
            exceeded: false,
            frozen: false,
            confidence: 1,
            priceShapingActive: false,
          },
          buckets: {
            startUtc: Array.from({ length: 24 }, (_, index) => hourStart(index)),
            startLocalLabels: Array.from({ length: 24 }, (_, index) => String(index)),
            plannedWeight: zeros,
            plannedKWh: Array.from({ length: 24 }, () => 1),
            plannedUncontrolledKWh: zeros,
            plannedControlledKWh: zeros,
            actualKWh: zeros,
            actualControlledKWh: zeros,
            actualUncontrolledKWh: zeros,
            allowedCumKWh: zeros,
            price: zeros,
            priceFactor: zeros,
          },
        },
      },
    };
  };
  const tracker = { buckets: { [hourStart(5)]: 1.4 } };

  it('paces the bucket the snapshot names while it lasts', () => {
    expect(resolveDailySoftLimitBucket(snapshotAtHour(5), tracker, DAY_START_MS + 5.5 * HOUR_MS)).toEqual({
      plannedKWh: 1,
      usedKWh: 1.4,
      bucketStartMs: DAY_START_MS + 5 * HOUR_MS,
      bucketEndMs: DAY_START_MS + 6 * HOUR_MS,
    });
  });

  it('paces nothing once that bucket has ended', () => {
    expect(resolveDailySoftLimitBucket(snapshotAtHour(5), tracker, DAY_START_MS + 6 * HOUR_MS)).toBeNull();
    expect(resolveDailySoftLimitBucket(snapshotAtHour(5), tracker, DAY_START_MS + 6 * HOUR_MS + 1_000)).toBeNull();
  });
});
