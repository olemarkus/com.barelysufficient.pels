import { canAdmitForMinRun } from '../../lib/plan/planMinRunAdmission';

describe('canAdmitForMinRun', () => {
  it('admits when used + draw·minRun/60 is at or under the soft budget', () => {
    // 1 kWh used + 2.5 kW · 20/60 h = 1 + 0.8333 = 1.8333 kWh <= 5 kWh budget.
    expect(canAdmitForMinRun({
      usedThisHourKWh: 1,
      drawKw: 2.5,
      minRunMinutes: 20,
      budgetKWh: 5,
    })).toBe(true);
  });

  it('admits at the exact budget boundary', () => {
    // 4 + 2 · 30/60 = 5 kWh, exactly the 5 kWh budget (<= passes).
    expect(canAdmitForMinRun({
      usedThisHourKWh: 4,
      drawKw: 2,
      minRunMinutes: 30,
      budgetKWh: 5,
    })).toBe(true);
  });

  it('rejects late in the hour when the min-run energy would exceed the budget', () => {
    // 4.8 + 2.5 · 20/60 = 4.8 + 0.8333 = 5.6333 kWh > 5 kWh budget.
    expect(canAdmitForMinRun({
      usedThisHourKWh: 4.8,
      drawKw: 2.5,
      minRunMinutes: 20,
      budgetKWh: 5,
    })).toBe(false);
  });

  it('returns false for a zero or undefined min-run time (legacy sentinel)', () => {
    expect(canAdmitForMinRun({ usedThisHourKWh: 0, drawKw: 2.5, minRunMinutes: 0, budgetKWh: 5 })).toBe(false);
    expect(canAdmitForMinRun({
      usedThisHourKWh: 0,
      drawKw: 2.5,
      minRunMinutes: undefined as unknown as number,
      budgetKWh: 5,
    })).toBe(false);
  });

  it('returns false for non-finite or negative inputs', () => {
    expect(canAdmitForMinRun({ usedThisHourKWh: 1, drawKw: 2.5, minRunMinutes: -10, budgetKWh: 5 })).toBe(false);
    expect(canAdmitForMinRun({ usedThisHourKWh: 1, drawKw: Number.NaN, minRunMinutes: 20, budgetKWh: 5 })).toBe(false);
    expect(canAdmitForMinRun({
      usedThisHourKWh: Number.POSITIVE_INFINITY,
      drawKw: 2.5,
      minRunMinutes: 20,
      budgetKWh: 5,
    })).toBe(false);
  });
});
