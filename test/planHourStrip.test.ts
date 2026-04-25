import { formatHourStripLabel, type PlanHourStripInput } from '../packages/shared-domain/src/planHourStrip';

const base = (overrides: Partial<PlanHourStripInput> = {}): PlanHourStripInput => ({
  softLimitSource: 'capacity',
  usedKWh: 4.2,
  budgetKWh: 12.0,
  minutesRemaining: 25,
  ...overrides,
});

describe('formatHourStripLabel', () => {
  it('returns an all-null shape when no meta is provided', () => {
    expect(formatHourStripLabel(undefined)).toEqual({
      primary: null,
      secondary: null,
      endsInMin: null,
      usedKWh: null,
      budgetKWh: null,
      usedFraction: null,
    });
  });

  it('formats the primary "used of budget" line', () => {
    const view = formatHourStripLabel(base());
    expect(view.primary).toBe('4.20 of 12.0 kWh');
    expect(view.usedKWh).toBe(4.2);
    expect(view.budgetKWh).toBe(12.0);
    expect(view.usedFraction).toBeCloseTo(0.35, 2);
  });

  it('uses dailyBudgetHourKWh when the soft-limit source is daily', () => {
    const view = formatHourStripLabel(base({
      softLimitSource: 'daily',
      budgetKWh: 12.0,
      dailyBudgetHourKWh: 3.0,
      usedKWh: 1.5,
    }));
    expect(view.primary).toBe('1.50 of 3.0 kWh');
    expect(view.budgetKWh).toBe(3.0);
    expect(view.usedFraction).toBeCloseTo(0.5, 2);
  });

  it('uses the soft-limit source as a plain-English secondary', () => {
    expect(formatHourStripLabel(base({ softLimitSource: 'capacity' })).secondary).toBe('Keeping under the power limit');
    expect(formatHourStripLabel(base({ softLimitSource: 'daily' })).secondary).toBe("Keeping within today's budget");
    expect(formatHourStripLabel(base({ softLimitSource: 'both' })).secondary)
      .toBe("Keeping within today's budget and power limit");
    expect(formatHourStripLabel(base({ softLimitSource: undefined })).secondary).toBeNull();
  });

  it('only surfaces endsInMin when there are ten or fewer minutes left', () => {
    expect(formatHourStripLabel(base({ minutesRemaining: 25 })).endsInMin).toBeNull();
    expect(formatHourStripLabel(base({ minutesRemaining: 10 })).endsInMin).toBe(10);
    expect(formatHourStripLabel(base({ minutesRemaining: 3 })).endsInMin).toBe(3);
    expect(formatHourStripLabel(base({ minutesRemaining: undefined })).endsInMin).toBeNull();
  });

  it('clamps usedFraction into 0..1', () => {
    const over = formatHourStripLabel(base({ usedKWh: 15, budgetKWh: 12 }));
    expect(over.usedFraction).toBe(1);
    const under = formatHourStripLabel(base({ usedKWh: -1, budgetKWh: 12 }));
    expect(under.usedFraction).toBe(0);
  });

  it('returns a null primary when the budget is missing', () => {
    expect(formatHourStripLabel(base({ budgetKWh: undefined })).primary).toBeNull();
  });
});
