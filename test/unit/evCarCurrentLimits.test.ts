import { describe, expect, it } from 'vitest';
import { isEvChargingCurrentLimitsMap, normalizeEvChargingCurrentLimitsMap, readEvChargingCurrentLimits } from '../../packages/shared-domain/src/settings/evChargingCurrentLimits';

describe('car current limits settings boundary', () => {
  it('keys independent ranges by car, without charger state', () => {
    expect(normalizeEvChargingCurrentLimitsMap({
      first: { minA: 9, maxA: 25 },
      second: { minA: 6, maxA: 32 },
    })).toEqual({ first: { minA: 9, maxA: 25 }, second: { minA: 6, maxA: 32 } });
  });

  it.each([
    undefined, null, [], '25', {}, { minA: 9 }, { minA: '6', maxA: 25 },
    { minA: 5, maxA: 25 }, { minA: 6, maxA: 33 }, { minA: 9, maxA: 8 },
    { minA: 6.5, maxA: 25 }, { minA: 6, maxA: Infinity }, { minA: NaN, maxA: 25 },
  ])('rejects incomplete or invalid car ranges: %j', (value) => {
    expect(readEvChargingCurrentLimits(value)).toBeUndefined();
  });

  it('rejects malformed policy maps before an accepted range can be erased', () => {
    expect(isEvChargingCurrentLimitsMap({ a: { minA: 9, maxA: 25 } })).toBe(true);
    expect(isEvChargingCurrentLimitsMap({ a: { minA: 9, maxA: 8 } })).toBe(false);
    expect(isEvChargingCurrentLimitsMap(null)).toBe(false);
    expect(isEvChargingCurrentLimitsMap({})).toBe(true);
  });

  it('keeps healthy car entries when a sibling entry is invalid', () => {
    expect(normalizeEvChargingCurrentLimitsMap({
      first: { minA: 9, maxA: 25 }, broken: { minA: 12, maxA: 8 }, '': { minA: 6, maxA: 32 },
    })).toEqual({ first: { minA: 9, maxA: 25 } });
  });
});
