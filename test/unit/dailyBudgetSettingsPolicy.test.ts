import { describe, expect, it } from 'vitest';
import {
  PRICE_FLEX_HIGH,
  PRICE_FLEX_LOW,
  PRICE_FLEX_MEDIUM,
  PRICE_SHAPING_FLEX_SHARE,
  UNMANAGED_RESERVE_CONSERVATIVE_MODE,
  UNMANAGED_RESERVE_MODE,
  normalizePriceFlexShare,
  normalizeUnmanagedReserveMode,
} from '../../packages/shared-domain/src/settings/dailyBudgetSettings';

// The runtime plans from these reads and the settings UI displays them, so a
// stored value must land on the same option on both sides.
describe('daily-budget option settings read policy', () => {
  it('snaps the price-flex share to Low, Medium or High, with the threshold itself Medium', () => {
    expect(normalizePriceFlexShare(0.3)).toBe(PRICE_FLEX_LOW);
    expect(normalizePriceFlexShare(0.31)).toBe(PRICE_FLEX_MEDIUM);
    expect(normalizePriceFlexShare(0.6)).toBe(PRICE_FLEX_MEDIUM);
    expect(normalizePriceFlexShare(0.7)).toBe(PRICE_FLEX_MEDIUM);
    expect(normalizePriceFlexShare(0.71)).toBe(PRICE_FLEX_HIGH);
    expect(normalizePriceFlexShare(0.85)).toBe(PRICE_FLEX_HIGH);
    expect(normalizePriceFlexShare(-1)).toBe(PRICE_FLEX_LOW);
    expect(normalizePriceFlexShare(5)).toBe(PRICE_FLEX_HIGH);
  });

  it('reads anything but a finite number as the default share', () => {
    for (const value of [undefined, null, '0.85', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(normalizePriceFlexShare(value)).toBe(PRICE_SHAPING_FLEX_SHARE);
    }
  });

  it('snaps the unmanaged-reserve mode to the nearer mode', () => {
    expect(normalizeUnmanagedReserveMode(0)).toBe(UNMANAGED_RESERVE_MODE);
    expect(normalizeUnmanagedReserveMode(0.49)).toBe(UNMANAGED_RESERVE_MODE);
    expect(normalizeUnmanagedReserveMode(0.5)).toBe(UNMANAGED_RESERVE_CONSERVATIVE_MODE);
    expect(normalizeUnmanagedReserveMode(1)).toBe(UNMANAGED_RESERVE_CONSERVATIVE_MODE);
  });

  it('reads anything but a finite number as the default reserve mode', () => {
    for (const value of [undefined, null, '1', Number.NaN, true]) {
      expect(normalizeUnmanagedReserveMode(value)).toBe(UNMANAGED_RESERVE_MODE);
    }
  });
});
