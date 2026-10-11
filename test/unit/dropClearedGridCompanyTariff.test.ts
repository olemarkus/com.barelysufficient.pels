import { describe, expect, it } from 'vitest';
import { dropClearedGridCompanyTariff } from '../../lib/price/gridTariffUtils';

const storeHolding = (stored: unknown) => {
  const store = {
    stored,
    readNettleie: () => store.stored,
    writeNettleie: (data: Array<Record<string, unknown>>) => { store.stored = data; },
  };
  return store;
};

const TARIFF = [{ time: 0, energyFeeExVat: 19.12, dateKey: '2026-10-11' }];

describe('dropClearedGridCompanyTariff', () => {
  it('drops the tariff of a grid company the owner cleared', () => {
    const store = storeHolding(TARIFF);

    expect(dropClearedGridCompanyTariff('', store)).toBe(true);
    expect(store.stored).toEqual([]);
  });

  it('keeps the tariff when the saved company only reads back nothing', () => {
    // A missed read of a listed key is not the owner clearing it.
    const store = storeHolding(TARIFF);

    expect(dropClearedGridCompanyTariff(undefined, store)).toBe(false);
    expect(dropClearedGridCompanyTariff(null, store)).toBe(false);
    expect(store.stored).toBe(TARIFF);
  });

  it('has nothing to drop without a stored tariff', () => {
    expect(dropClearedGridCompanyTariff('', storeHolding([]))).toBe(false);
    expect(dropClearedGridCompanyTariff('', storeHolding(null))).toBe(false);
  });
});
