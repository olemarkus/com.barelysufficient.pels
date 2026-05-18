import { resolvePriceLevelChip } from '../packages/shared-domain/src/priceLevelChips';

describe('resolvePriceLevelChip', () => {
  it('maps cheap to a Price low / info chip', () => {
    const chip = resolvePriceLevelChip('cheap');
    expect(chip).toEqual({ label: 'Price low', tone: 'info', priceLevel: 'cheap' });
  });

  it('maps expensive to a Price high / warn chip', () => {
    const chip = resolvePriceLevelChip('expensive');
    expect(chip).toEqual({ label: 'Price high', tone: 'warn', priceLevel: 'expensive' });
  });

  it('returns null for normal, null, undefined, and empty strings', () => {
    expect(resolvePriceLevelChip('normal')).toBeNull();
    expect(resolvePriceLevelChip(null)).toBeNull();
    expect(resolvePriceLevelChip(undefined)).toBeNull();
    expect(resolvePriceLevelChip('')).toBeNull();
  });

  it('returns null for unrecognized free-form price-level strings', () => {
    expect(resolvePriceLevelChip('very_expensive')).toBeNull();
    expect(resolvePriceLevelChip('unknown')).toBeNull();
  });

  it('returns null for inherited Object.prototype property names', () => {
    // `value in PRICE_LEVEL_CHIP_DEFS` would walk the prototype chain and
    // match `toString` / `constructor`, producing a chip with undefined
    // label/tone. Own-property lookup must keep these safely null.
    expect(resolvePriceLevelChip('toString')).toBeNull();
    expect(resolvePriceLevelChip('constructor')).toBeNull();
    expect(resolvePriceLevelChip('hasOwnProperty')).toBeNull();
  });
});
