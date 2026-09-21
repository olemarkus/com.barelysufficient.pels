import { describe, expect, it } from 'vitest';
import { classifyPriceOptimizationConfigMap } from '../src/ui/priceOptimizationConfig.ts';

describe('classifyPriceOptimizationConfigMap', () => {
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
