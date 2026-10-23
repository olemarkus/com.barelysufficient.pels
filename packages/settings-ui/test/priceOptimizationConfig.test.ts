import { describe, expect, it } from 'vitest';
import { classifyPriceOptimizationConfigMap, DEFAULT_SURPLUS_LIFT_C } from '../../shared-domain/src/settings/priceOptimization.ts';

describe('classifyPriceOptimizationConfigMap', () => {
  it('preserves device ids that name object prototype members as own settings', () => {
    const entry = { enabled: true, cheapDelta: 5, expensiveDelta: -5 };
    const read = classifyPriceOptimizationConfigMap(Object.fromEntries([
      ['__proto__', entry], ['constructor', entry],
    ]));
    expect(read.state).toBe('resolved');
    if (read.state !== 'resolved') throw new Error('Expected a readable map');
    expect(Object.keys(read.settings)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(read.settings)).toBe(Object.prototype);
    expect(read.settings['__proto__'].enabled).toBe(true);
  });

  it('reads an entry that stores no solar lift with the lift the runtime applies', () => {
    expect(classifyPriceOptimizationConfigMap({
      heater: { enabled: false, cheapDelta: 5, expensiveDelta: -5 },
    })).toEqual({
      state: 'resolved',
      settings: {
        heater: {
          enabled: false,
          cheapDelta: 5,
          expensiveDelta: -5,
          priceConfigured: true,
          surplusWilling: false,
          surplusDelta: DEFAULT_SURPLUS_LIFT_C,
        },
      },
    });
  });

  it('preserves explicit Price provenance independently of solar participation', () => {
    expect(classifyPriceOptimizationConfigMap({
      explicitOff: {
        enabled: false,
        cheapDelta: 5,
        expensiveDelta: -5,
        priceConfigured: true,
        surplusWilling: true,
        surplusDelta: 2,
      },
      solarOnly: {
        enabled: false,
        cheapDelta: 0,
        expensiveDelta: 0,
        priceConfigured: false,
        surplusWilling: true,
        surplusDelta: 0,
      },
    })).toEqual({
      state: 'resolved',
      settings: {
        explicitOff: {
          enabled: false,
          cheapDelta: 5,
          expensiveDelta: -5,
          priceConfigured: true,
          surplusWilling: true,
          surplusDelta: 2,
        },
        solarOnly: {
          enabled: false,
          cheapDelta: 0,
          expensiveDelta: 0,
          priceConfigured: false,
          surplusWilling: true,
          surplusDelta: 0,
        },
      },
    });
  });

  it('preserves configured status for legacy entries whose provenance was not stored', () => {
    expect(classifyPriceOptimizationConfigMap({
      solarOnly: {
        enabled: false,
        cheapDelta: 0,
        expensiveDelta: 0,
        surplusWilling: true,
      },
      priceOnly: {
        enabled: false,
        cheapDelta: 5,
        expensiveDelta: -5,
      },
    })).toEqual({
      state: 'resolved',
      settings: {
        solarOnly: {
          enabled: false,
          cheapDelta: 0,
          expensiveDelta: 0,
          priceConfigured: true,
          surplusWilling: true,
          surplusDelta: 2,
        },
        priceOnly: {
          enabled: false,
          cheapDelta: 5,
          expensiveDelta: -5,
          priceConfigured: true,
          surplusWilling: false,
          surplusDelta: 2,
        },
      },
    });
  });
});
