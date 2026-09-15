import { describe, it, expect } from 'vitest';
import { applyPriceShift } from '../../lib/thermostat/priceShift';
import { PriceLevel } from '../../lib/price/priceLevels';

// The owner's stored pair, written in heating terms: boost while cheap, coast
// while expensive. The UI collects the two as magnitudes and stores these signs.
const config = { enabled: true, cheapDelta: 5, expensiveDelta: -5 };

describe('applyPriceShift', () => {
  it('stores heat in a cheap hour and coasts in an expensive one while heating', () => {
    expect(applyPriceShift(50, config, PriceLevel.CHEAP, 'heating')).toBe(55);
    expect(applyPriceShift(50, config, PriceLevel.EXPENSIVE, 'heating')).toBe(45);
  });

  it('inverts both moves while cooling', () => {
    // Same magnitudes, opposite setpoint: cooling harder while power is cheap is
    // a LOWER setpoint, and coasting through the expensive hour is a higher one.
    expect(applyPriceShift(22, config, PriceLevel.CHEAP, 'cooling')).toBe(17);
    expect(applyPriceShift(22, config, PriceLevel.EXPENSIVE, 'cooling')).toBe(27);
  });

  it('leaves the target alone at a normal price level, in either direction', () => {
    expect(applyPriceShift(50, config, PriceLevel.NORMAL, 'heating')).toBe(50);
    expect(applyPriceShift(22, config, PriceLevel.NORMAL, 'cooling')).toBe(22);
  });

  it('leaves the target alone when the configured delta is zero', () => {
    const noShift = { enabled: true, cheapDelta: 0, expensiveDelta: 0 };
    expect(applyPriceShift(22, noShift, PriceLevel.CHEAP, 'cooling')).toBe(22);
    expect(applyPriceShift(22, noShift, PriceLevel.EXPENSIVE, 'cooling')).toBe(22);
  });

  it('reads the configured numbers as magnitudes, not as signs', () => {
    // The stored convention is heating-shaped, but the device-detail editor's
    // cheap field accepts a negative and the persisted boundary gates only
    // finiteness — so a negative `cheapDelta` is reachable, and an owner who
    // hand-worked-around the old inversion on an air conditioner is exactly who
    // would hold one. Both surfaces LABEL the pair as boost and reduction, so
    // both magnitudes buy the same behaviour whatever sign they carry.
    const backwards = { enabled: true, cheapDelta: -5, expensiveDelta: 5 };
    expect(applyPriceShift(50, backwards, PriceLevel.CHEAP, 'heating')).toBe(55);
    expect(applyPriceShift(50, backwards, PriceLevel.EXPENSIVE, 'heating')).toBe(45);
    expect(applyPriceShift(22, backwards, PriceLevel.CHEAP, 'cooling')).toBe(17);
    expect(applyPriceShift(22, backwards, PriceLevel.EXPENSIVE, 'cooling')).toBe(27);
  });
});
