import { beforeEach, describe, expect, it } from 'vitest';
import { TemperaturePriceShiftPolicy } from '../../lib/thermostat/priceShiftPolicy';
import { PriceLevel } from '../../lib/price/priceLevels';
import { mockHomeyInstance } from '../mocks/homey';

const CANCELLATION_KEY = 'thermostat_price_shift_cancellation.heater';

describe('manual temperature price-shift hold', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set('test_existing_setting', true);
  });

  it('does not hold a price level when optimization is off', () => {
    const policy = new TemperaturePriceShiftPolicy(
      mockHomeyInstance.settings,
      () => PriceLevel.CHEAP,
      () => false,
      () => ({ heater: { enabled: true, cheapDelta: 2, expensiveDelta: -3, surplusWilling: false, surplusDelta: 0 } }),
      () => 'heating',
      (_deviceId, value) => value,
    );

    expect(policy.cancelCurrentPriceShift('heater')).toBe(true);
    expect(mockHomeyInstance.settings.get(CANCELLATION_KEY)).toBeNull();
    expect(policy.hasPendingCancellations(['heater'])).toBe(false);
  });

  it('keeps a device at its saved target through the canceled level, including after restart', () => {
    let currentLevel = PriceLevel.EXPENSIVE;
    const reads = {
      settings: mockHomeyInstance.settings,
      getCurrentPriceLevel: () => currentLevel,
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => ({
        heater: { enabled: true, cheapDelta: 2, expensiveDelta: -3, surplusWilling: false, surplusDelta: 0 },
      }),
      getThermalDirection: () => 'heating' as const,
      normalizeTarget: (_deviceId: string, value: number) => value,
    };
    const beforeRestart = new TemperaturePriceShiftPolicy(
      reads.settings, reads.getCurrentPriceLevel, reads.getPriceOptimizationEnabled,
      reads.getPriceOptimizationSettings, reads.getThermalDirection, reads.normalizeTarget,
    );

    expect(beforeRestart.shouldApplyPriceShift('heater', currentLevel)).toBe(true);
    beforeRestart.cancelCurrentPriceShift('heater');
    expect(mockHomeyInstance.settings.get(CANCELLATION_KEY)).toBe(PriceLevel.EXPENSIVE);
    expect(beforeRestart.allowsCurrentPriceShiftTarget('heater', 22, 19)).toBe(false);

    const afterRestart = new TemperaturePriceShiftPolicy(
      reads.settings, reads.getCurrentPriceLevel, reads.getPriceOptimizationEnabled,
      reads.getPriceOptimizationSettings, reads.getThermalDirection, reads.normalizeTarget,
    );
    expect(afterRestart.shouldApplyPriceShift('heater', PriceLevel.UNKNOWN)).toBe(false);
    expect(afterRestart.shouldApplyPriceShift('heater', PriceLevel.EXPENSIVE)).toBe(false);
    expect(afterRestart.allowsCurrentPriceShiftTarget('heater', 22, 19)).toBe(false);

    currentLevel = PriceLevel.NORMAL;
    expect(afterRestart.shouldApplyPriceShift('heater', currentLevel)).toBe(true);
    expect(mockHomeyInstance.settings.get(CANCELLATION_KEY)).toBeNull();
    expect(afterRestart.allowsCurrentPriceShiftTarget('heater', 22, 19)).toBe(false);

    currentLevel = PriceLevel.CHEAP;
    expect(afterRestart.allowsCurrentPriceShiftTarget('heater', 22, 24)).toBe(true);
  });

  it('keeps the hold scoped to the device that changed its temperature', () => {
    const policy = new TemperaturePriceShiftPolicy(
      mockHomeyInstance.settings,
      () => PriceLevel.CHEAP,
      () => true,
      () => ({
        heater: { enabled: true, cheapDelta: 2, expensiveDelta: -3, surplusWilling: false, surplusDelta: 0 },
      }),
      () => 'heating',
      (_deviceId, value) => value,
    );
    policy.cancelCurrentPriceShift('heater');

    expect(policy.shouldApplyPriceShift('heater', PriceLevel.CHEAP)).toBe(false);
    expect(policy.shouldApplyPriceShift('water-heater', PriceLevel.CHEAP)).toBe(true);
  });

  it('does not keep resolving the price level for a removed or transferred device hold', () => {
    const policy = new TemperaturePriceShiftPolicy(
      mockHomeyInstance.settings,
      () => PriceLevel.CHEAP,
      () => true,
      () => ({}),
      () => 'heating',
      (_deviceId, value) => value,
    );
    mockHomeyInstance.settings.set(CANCELLATION_KEY, PriceLevel.EXPENSIVE);

    expect(policy.hasPendingCancellations(['water-heater'])).toBe(false);
    expect(policy.hasPendingCancellations([])).toBe(false);
    expect(policy.hasPendingCancellations(['heater'])).toBe(true);
  });

  it('does not treat a transient empty settings key list as proof that a hold is absent', () => {
    mockHomeyInstance.settings.set(CANCELLATION_KEY, PriceLevel.EXPENSIVE);
    const source = mockHomeyInstance.settings;
    const policy = new TemperaturePriceShiftPolicy(
      {
        get: (key) => key === CANCELLATION_KEY ? undefined : source.get(key),
        set: (key, value) => source.set(key, value),
        unset: (key) => source.unset(key),
        getKeys: () => [],
      },
      () => PriceLevel.EXPENSIVE,
      () => true,
      () => ({}),
      () => 'heating',
      (_deviceId, value) => value,
    );

    expect(policy.shouldApplyPriceShift('heater', PriceLevel.EXPENSIVE)).toBe(false);
  });

  it('expires a saved hold when a level change is observed', () => {
    let currentLevel = PriceLevel.EXPENSIVE;
    const policy = new TemperaturePriceShiftPolicy(
      mockHomeyInstance.settings,
      () => currentLevel,
      () => true,
      () => ({
        heater: { enabled: true, cheapDelta: 2, expensiveDelta: -3, surplusWilling: false, surplusDelta: 0 },
      }),
      () => 'heating',
      (_deviceId, value) => value,
    );
    expect(policy.cancelCurrentPriceShift('heater')).toBe(true);
    expect(policy.hasPendingCancellations(['heater'])).toBe(true);

    currentLevel = PriceLevel.NORMAL;
    expect(policy.shouldApplyPriceShift('heater', currentLevel)).toBe(true);
    expect(policy.hasPendingCancellations(['heater'])).toBe(false);
  });
});
