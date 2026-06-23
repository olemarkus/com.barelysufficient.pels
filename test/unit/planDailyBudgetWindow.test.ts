import {
  getHourUsageSplit,
  resolveHourlyUsageSplit,
} from '../../lib/plan/planDailyBudgetWindow';

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
