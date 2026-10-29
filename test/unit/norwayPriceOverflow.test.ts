import { describe, expect, it } from 'vitest';
import { buildCombinedHourlyPricesNorway } from '../../lib/price/priceServiceNorway';

const price = (spotPriceExVat: number, norwayPriceModel: 'stromstotte' | 'norgespris') => (
  buildCombinedHourlyPricesNorway({
    spotPrices: [{ startsAt: '2026-10-29T10:00:00Z', spotPriceExVat }],
    gridTariffData: [], providerSurchargeIncVat: 0,
    priceArea: 'NO1', countyCode: '03', tariffGroup: 'Husholdning', norwayPriceModel,
    now: new Date('2026-10-29T09:00:00Z'), timeZone: 'Europe/Oslo',
  })
);

describe('Norway resolved price values', () => {
  it.each(['stromstotte', 'norgespris'] as const)('omits finite inputs that overflow the %s calculation', (model) => {
    expect(price(1.5e308, model)).toEqual([]);
  });

  it('preserves ordinary negative spot and total prices', () => {
    const [resolved] = price(-100, 'stromstotte');
    expect(resolved?.spotPriceExVat).toBe(-100);
    expect(resolved?.totalPrice).toBeLessThan(0);
    expect(Number.isFinite(resolved?.totalPrice)).toBe(true);
  });
});
