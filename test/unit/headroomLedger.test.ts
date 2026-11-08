import { buildRestoreHeadroomLedger } from '../../lib/plan/restore/headroomLedger';

describe('restore headroom ledger', () => {
  it('keeps grid headroom binding for budget-exempt admissions and debits it for every increase', () => {
    const ledger = buildRestoreHeadroomLedger({ phase: { kind: 'off' }, capacity: { kind: 'off' }, grid: { kind: 'on', kw: 1.5 }, budget: { kind: 'on', kw: 0.2 } });
    expect(ledger.availableFor({ budgetExempt: true, phaseFootprint: { kind: 'unknown' } })).toBe(1.5);
    ledger.commit({ budgetExempt: true, phaseFootprint: { kind: 'unknown' } }, 1);
    expect(ledger.availableFor({ budgetExempt: true, phaseFootprint: { kind: 'unknown' } })).toBe(0.5);
    expect(ledger.availableFor({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } })).toBe(0.2);
    ledger.commit({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } }, 0.2);
    expect(ledger.axes()).toEqual({ capacity: { kind: 'off' }, grid: { kind: 'on', kw: 0.3 }, budget: { kind: 'on', kw: 0 }, phase: { kind: 'off' } });
  });

  it('expresses no power constraint as absence while preserving a budget-only constraint', () => {
    const ledger = buildRestoreHeadroomLedger({ phase: { kind: 'off' }, capacity: { kind: 'off' }, grid: { kind: 'off' }, budget: { kind: 'on', kw: 0.5 } });
    expect(ledger.availableFor({ budgetExempt: true, phaseFootprint: { kind: 'unknown' } })).toBeNull();
    expect(ledger.availableFor({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } })).toBe(0.5);
    ledger.commit({ budgetExempt: true, phaseFootprint: { kind: 'unknown' } }, 2);
    expect(ledger.summaryAvailableKw()).toBe(0.5);
  });

  it('routes exempt candidates to the capacity axis and non-exempt to the min view', () => {
    const ledger = buildRestoreHeadroomLedger({ phase: { kind: 'off' }, grid: { kind: 'off' }, capacity: { kind: 'on', kw: 10 }, budget: { kind: 'on', kw: 0.7 } });
    expect(ledger.availableFor({ budgetExempt: true, phaseFootprint: { kind: 'unknown' } })).toBe(10);
    expect(ledger.availableFor({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } })).toBe(0.7);
    expect(ledger.summaryAvailableKw()).toBe(0.7);
  });

  it('treats a missing budget axis as capacity-only', () => {
    const ledger = buildRestoreHeadroomLedger({ phase: { kind: 'off' }, grid: { kind: 'off' }, capacity: { kind: 'on', kw: 3 }, budget: { kind: 'off' } });
    expect(ledger.availableFor({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } })).toBe(3);
    expect(ledger.summaryAvailableKw()).toBe(3);
  });

  it('debits capacity for every commit and budget only for non-exempt commits', () => {
    const ledger = buildRestoreHeadroomLedger({ phase: { kind: 'off' }, grid: { kind: 'off' }, capacity: { kind: 'on', kw: 10 }, budget: { kind: 'on', kw: 2 } });
    ledger.commit({ budgetExempt: true, phaseFootprint: { kind: 'unknown' } }, 1.5);
    expect(ledger.availableFor({ budgetExempt: true, phaseFootprint: { kind: 'unknown' } })).toBe(8.5);
    expect(ledger.availableFor({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } })).toBe(2);
    ledger.commit({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } }, 0.5);
    expect(ledger.availableFor({ budgetExempt: true, phaseFootprint: { kind: 'unknown' } })).toBe(8);
    expect(ledger.availableFor({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } })).toBe(1.5);
  });

  it('exposes post-pass axes for the hold lane', () => {
    const ledger = buildRestoreHeadroomLedger({ phase: { kind: 'off' }, grid: { kind: 'off' }, capacity: { kind: 'on', kw: 10 }, budget: { kind: 'on', kw: 2 } });
    ledger.commit({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } }, 0.5);
    expect(ledger.axes()).toEqual({ grid: { kind: 'off' }, capacity: { kind: 'on', kw: 9.5 }, budget: { kind: 'on', kw: 1.5 }, phase: { kind: 'off' } });
  });

  it('drops NaN and non-positive deltas instead of poisoning the axes', () => {
    const ledger = buildRestoreHeadroomLedger({ phase: { kind: 'off' }, grid: { kind: 'off' }, capacity: { kind: 'on', kw: 5 }, budget: { kind: 'on', kw: 1 } });
    ledger.commit({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } }, Number.NaN);
    ledger.commit({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } }, -2);
    ledger.commit({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } }, 0);
    expect(ledger.availableFor({ budgetExempt: false, phaseFootprint: { kind: 'unknown' } })).toBe(1);
    expect(ledger.summaryAvailableKw()).toBe(1);
  });
});
