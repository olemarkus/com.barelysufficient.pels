import { buildRestoreHeadroomLedger } from '../../lib/plan/restore/headroomLedger';

describe('restore headroom ledger', () => {
  it('keeps grid headroom binding for budget-exempt admissions and debits it for every increase', () => {
    const ledger = buildRestoreHeadroomLedger({ capacityAvailableKw: null, gridAvailableKw: 1.5, budgetAvailableKw: 0.2 });
    expect(ledger.availableFor({ budgetExempt: true })).toBe(1.5);
    ledger.commit({ budgetExempt: true }, 1);
    expect(ledger.availableFor({ budgetExempt: true })).toBe(0.5);
    expect(ledger.availableFor({})).toBe(0.2);
    ledger.commit({}, 0.2);
    expect(ledger.axes()).toEqual({ capacityAvailableKw: null, gridAvailableKw: 0.3, budgetAvailableKw: 0 });
  });

  it('expresses no power constraint as absence while preserving a budget-only constraint', () => {
    const ledger = buildRestoreHeadroomLedger({ capacityAvailableKw: null, gridAvailableKw: null, budgetAvailableKw: 0.5 });
    expect(ledger.availableFor({ budgetExempt: true })).toBeNull();
    expect(ledger.availableFor({})).toBe(0.5);
    ledger.commit({ budgetExempt: true }, 2);
    expect(ledger.summaryAvailableKw()).toBe(0.5);
  });

  it('routes exempt candidates to the capacity axis and non-exempt to the min view', () => {
    const ledger = buildRestoreHeadroomLedger({ gridAvailableKw: null, capacityAvailableKw: 10, budgetAvailableKw: 0.7 });
    expect(ledger.availableFor({ budgetExempt: true })).toBe(10);
    expect(ledger.availableFor({ budgetExempt: undefined })).toBe(0.7);
    expect(ledger.summaryAvailableKw()).toBe(0.7);
  });

  it('treats a missing budget axis as capacity-only', () => {
    const ledger = buildRestoreHeadroomLedger({ gridAvailableKw: null, capacityAvailableKw: 3, budgetAvailableKw: null });
    expect(ledger.availableFor({ budgetExempt: undefined })).toBe(3);
    expect(ledger.summaryAvailableKw()).toBe(3);
  });

  it('debits capacity for every commit and budget only for non-exempt commits', () => {
    const ledger = buildRestoreHeadroomLedger({ gridAvailableKw: null, capacityAvailableKw: 10, budgetAvailableKw: 2 });
    ledger.commit({ budgetExempt: true }, 1.5);
    expect(ledger.availableFor({ budgetExempt: true })).toBe(8.5);
    expect(ledger.availableFor({ budgetExempt: undefined })).toBe(2);
    ledger.commit({ budgetExempt: undefined }, 0.5);
    expect(ledger.availableFor({ budgetExempt: true })).toBe(8);
    expect(ledger.availableFor({ budgetExempt: undefined })).toBe(1.5);
  });

  it('exposes post-pass axes for the hold lane', () => {
    const ledger = buildRestoreHeadroomLedger({ gridAvailableKw: null, capacityAvailableKw: 10, budgetAvailableKw: 2 });
    ledger.commit({ budgetExempt: undefined }, 0.5);
    expect(ledger.axes()).toEqual({ gridAvailableKw: null, capacityAvailableKw: 9.5, budgetAvailableKw: 1.5 });
  });

  it('drops NaN and non-positive deltas instead of poisoning the axes', () => {
    const ledger = buildRestoreHeadroomLedger({ gridAvailableKw: null, capacityAvailableKw: 5, budgetAvailableKw: 1 });
    ledger.commit({ budgetExempt: undefined }, Number.NaN);
    ledger.commit({ budgetExempt: undefined }, -2);
    ledger.commit({ budgetExempt: undefined }, 0);
    expect(ledger.availableFor({ budgetExempt: undefined })).toBe(1);
    expect(ledger.summaryAvailableKw()).toBe(1);
  });
});
