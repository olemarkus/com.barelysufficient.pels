/**
 * @jest-environment node
 */
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';

const {
  buildPlanPriceWidgetPayload,
  resolveLabel,
  resolveLabelEvery,
  resolvePriceSeries,
  resolveWidgetTarget,
} = require('../widgets/plan_budget/planPriceWidgetPayload.js');

const buildDay = (bucketCount: number): DailyBudgetDayPayload => {
  const startUtc = Array.from({ length: bucketCount }, (_value, index) => (
    new Date(Date.UTC(2026, 2, 19, index, 0, 0, 0)).toISOString()
  ));
  const zeroes = Array.from({ length: bucketCount }, () => 0);

  return {
    dateKey: '2026-03-19',
    timeZone: 'Europe/Oslo',
    nowUtc: '2026-03-19T10:00:00.000Z',
    dayStartUtc: '2026-03-19T00:00:00.000Z',
    currentBucketIndex: 10,
    budget: {
      enabled: true,
      dailyBudgetKWh: 12,
      priceShapingEnabled: false,
    },
    state: {
      usedNowKWh: 2.3,
      allowedNowKWh: 2.5,
      remainingKWh: 9.5,
      deviationKWh: -0.2,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: false,
    },
    buckets: {
      startUtc,
      startLocalLabels: Array.from({ length: bucketCount }, (_value, index) => `${String(index).padStart(2, '0')}:00`),
      plannedWeight: zeroes,
      plannedKWh: Array.from({ length: bucketCount }, (_value, index) => 0.25 + (index * 0.01)),
      actualKWh: Array.from({ length: bucketCount }, (_value, index) => (index <= 10 ? 0.2 + (index * 0.01) : 0)),
      allowedCumKWh: zeroes,
      price: Array.from({ length: bucketCount }, (_value, index) => 75 + index),
    },
  };
};

describe('plan price widget payload', () => {
  test('builds a ready payload for today with actuals', () => {
    const day = buildDay(24);
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot,
      combinedPrices: null,
      target: 'today',
    });

    expect(payload.state).toBe('ready');
    expect(payload.target).toBe('today');
    expect(payload.showActual).toBe(true);
    expect(payload.showNow).toBe(true);
    expect(payload.currentIndex).toBe(10);
    expect(payload.bucketLabels).toHaveLength(24);
    expect(payload.priceSeries[0]).toBe(75);
  });

  test('returns tomorrow empty state when no tomorrow plan exists', () => {
    const day = buildDay(24);
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot,
      combinedPrices: null,
      target: 'tomorrow',
    });

    expect(payload).toEqual({
      state: 'empty',
      target: 'tomorrow',
      title: 'Budget and Price',
      subtitle: 'Tomorrow plan not available yet',
    });
  });

  test('returns budget disabled empty state when the selected day has no buckets', () => {
    const day = buildDay(0);
    day.budget.enabled = false;
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot,
      combinedPrices: null,
      target: 'today',
    });

    expect(payload).toEqual({
      state: 'empty',
      target: 'today',
      title: 'Budget and Price',
      subtitle: 'Daily budget disabled',
    });
  });

  test('omits actual usage markers for tomorrow payloads', () => {
    const today = buildDay(24);
    const tomorrow = buildDay(24);
    tomorrow.dateKey = '2026-03-20';
    tomorrow.currentBucketIndex = 5;
    tomorrow.buckets.actualKWh = Array.from({ length: 24 }, () => 0.4);
    const snapshot: DailyBudgetUiPayload = {
      days: {
        [today.dateKey]: today,
        [tomorrow.dateKey]: tomorrow,
      },
      todayKey: today.dateKey,
      tomorrowKey: tomorrow.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot,
      combinedPrices: null,
      target: 'tomorrow',
    });

    expect(payload.state).toBe('ready');
    expect(payload.target).toBe('tomorrow');
    expect(payload.showActual).toBe(false);
    expect(payload.showNow).toBe(false);
  });

  test('uses combined prices when bucket prices are missing', () => {
    const bucketStartUtc = [
      '2026-03-19T00:00:00.000Z',
      '2026-03-19T01:00:00.000Z',
    ];

    const series = resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: [1],
      combinedPrices: {
        prices: [{ startsAt: bucketStartUtc[1], total: 123 }],
      },
    });

    expect(series).toEqual([null, 123]);
  });

  test('resolves labels and intervals consistently', () => {
    expect(resolveLabel(['06:00', ''], ['2026-03-19T06:00:00.000Z', '2026-03-19T07:00:00.000Z'], 0)).toBe('06');
    expect(resolveLabel([':00'], [], 0)).toBe('');
    expect(resolveLabelEvery(24)).toBe(4);
    expect(resolveWidgetTarget('tomorrow')).toBe('tomorrow');
    expect(resolveWidgetTarget('unexpected')).toBe('today');
  });
});
