import { describe, expect, it } from 'vitest';
import { resolvePriceOptimizationConfig } from '../../lib/price/priceOptimizer';

describe('resolvePriceOptimizationConfig', () => {
  it('reads a device with no entry, including one named like a prototype member, as not price-aware', () => {
    expect(resolvePriceOptimizationConfig({}, 'toString')).toEqual({
      enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusLiftC: 0,
    });
  });

  it('carries a surplus lift only when the owner opted in with a positive one', () => {
    const base = { enabled: true, cheapDelta: 2, expensiveDelta: -2 };
    expect(resolvePriceOptimizationConfig({ hp: { ...base, surplusWilling: true, surplusDelta: 1.5 } }, 'hp').surplusLiftC)
      .toBe(1.5);
    expect(resolvePriceOptimizationConfig({ hp: { ...base, surplusWilling: false, surplusDelta: 1.5 } }, 'hp').surplusLiftC)
      .toBe(0);
    expect(resolvePriceOptimizationConfig({ hp: { ...base, surplusWilling: true, surplusDelta: 0 } }, 'hp').surplusLiftC)
      .toBe(0);
    expect(resolvePriceOptimizationConfig({ hp: base }, 'hp')).toEqual({ ...base, surplusLiftC: 0 });
  });
});
