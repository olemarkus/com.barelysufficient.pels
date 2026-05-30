/**
 * @vitest-environment node
 */
import {
  formatPlanPriceSummary,
  resolvePlanPriceCostDisplay,
} from '../packages/shared-domain/src/planPriceWidgetCopy';

describe('plan price widget copy', () => {
  test('resolves the Norwegian øre→kr cost display by default', () => {
    expect(resolvePlanPriceCostDisplay({})).toEqual({
      costUnit: 'kr',
      costDivisor: 100,
      priceAxisUnit: 'øre/kWh',
    });
    expect(resolvePlanPriceCostDisplay({ priceScheme: 'norway' }).costDivisor).toBe(100);
  });

  test('uses the supplied unit with divisor 1 for flow/homey schemes', () => {
    expect(resolvePlanPriceCostDisplay({ priceScheme: 'homey', priceUnit: 'NOK' })).toEqual({
      costUnit: 'NOK',
      costDivisor: 1,
      priceAxisUnit: 'NOK/kWh',
    });
    // A unit that already carries /kWh is not doubled up.
    expect(resolvePlanPriceCostDisplay({ priceScheme: 'flow', priceUnit: 'kr/kWh' }).priceAxisUnit)
      .toBe('kr/kWh');
  });

  test('strips the /kWh rate suffix from the TOTAL cost unit (rate-shaped source unit)', () => {
    // A rate-shaped source unit like `kr/kWh` must read `kr` as a total — never
    // `12.3 kr/kWh` — while the axis keeps the per-kWh rate shape.
    expect(resolvePlanPriceCostDisplay({ priceScheme: 'flow', priceUnit: 'kr/kWh' })).toEqual({
      costUnit: 'kr',
      costDivisor: 1,
      priceAxisUnit: 'kr/kWh',
    });
    // A spaced rate suffix (`NOK / kWh`) is recognized too: total strips to
    // `NOK`, and the axis keeps the rate shape instead of doubling to
    // `NOK / kWh/kWh`.
    expect(resolvePlanPriceCostDisplay({ priceScheme: 'homey', priceUnit: 'NOK / kWh' })).toEqual({
      costUnit: 'NOK',
      costDivisor: 1,
      priceAxisUnit: 'NOK / kWh',
    });
  });

  test('drops the unit for a placeholder/empty flow unit', () => {
    expect(resolvePlanPriceCostDisplay({ priceScheme: 'flow', priceUnit: 'price units' })).toEqual({
      costUnit: '',
      costDivisor: 1,
      priceAxisUnit: '',
    });
    expect(resolvePlanPriceCostDisplay({ priceScheme: 'flow' }).costUnit).toBe('');
  });

  test('formats the summary line with kWh, cost, and tone', () => {
    expect(formatPlanPriceSummary({
      projectedKwh: 12.42,
      projectedCost: 9.8,
      costUnit: 'kr',
      tone: 'on_track',
    })).toBe('Projected 12.4 kWh · 9.80 kr · On track');

    expect(formatPlanPriceSummary({
      projectedKwh: 20,
      projectedCost: 31.5,
      costUnit: 'kr',
      tone: 'over',
    })).toBe('Projected 20.0 kWh · 31.50 kr · Over budget');
  });

  test('drops the cost half when no usable unit and the tone when null', () => {
    expect(formatPlanPriceSummary({
      projectedKwh: 5,
      projectedCost: 4,
      costUnit: '',
      tone: null,
    })).toBe('Projected 5.0 kWh');

    expect(formatPlanPriceSummary({
      projectedKwh: 5,
      projectedCost: null,
      costUnit: 'kr',
      tone: null,
    })).toBe('Projected 5.0 kWh');
  });
});
