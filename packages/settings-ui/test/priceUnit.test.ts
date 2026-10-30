import { describe, expect, it } from 'vitest';
import {
  resolveInlinePriceUnit,
  resolvePriceUnitLabel,
  withInlinePriceUnit,
} from '../src/ui/priceUnit.ts';

describe('inline price unit', () => {
  it('keeps the per-kWh unit after a number', () => {
    const unit = resolveInlinePriceUnit({ unit: 'kr', divisor: 100 });
    expect(unit).toBe('kr/kWh');
    expect(withInlinePriceUnit('0.20', unit)).toBe('0.20 kr/kWh');
  });

  it('prints the bare number for prices without a unit', () => {
    // Flow prices carry no unit. `Price` names an axis; after a number it read
    // as a unit (`Now · 2.20 Price`).
    const display = { unit: '', divisor: 1 };
    expect(resolvePriceUnitLabel(display)).toBe('Price');
    expect(resolveInlinePriceUnit(display)).toBe('');
    expect(withInlinePriceUnit('2.20', resolveInlinePriceUnit(display))).toBe('2.20');
  });
});
