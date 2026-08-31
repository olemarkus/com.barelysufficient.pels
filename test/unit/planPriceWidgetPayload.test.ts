/**
 * @vitest-environment node
 */
import type {
  DailyBudgetDayPayload,
  DailyBudgetUiPayload,
  DailyBudgetUiRead,
} from '../../lib/dailyBudget/dailyBudgetTypes';
import {
  buildPlanPriceWidgetPayload,
  resolveLabel,
  resolveLabelEvery,
  resolvePriceSeries,
  resolveWidgetTarget,
} from '../../widgets/plan_budget/src/planPriceWidgetPayload';

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
      plannedUncontrolledKWh: zeroes,
      plannedControlledKWh: zeroes,
      actualKWh: Array.from({ length: bucketCount }, (_value, index) => (index <= 10 ? 0.2 + (index * 0.01) : 0)),
      actualControlledKWh: Array.from({ length: bucketCount }, () => null),
      actualUncontrolledKWh: Array.from({ length: bucketCount }, () => null),
      allowedCumKWh: zeroes,
      price: Array.from({ length: bucketCount }, (_value, index) => 75 + index),
    },
  };
};

// The builder takes the host API's discriminated read; these cases all exercise
// the `budget` arm, so wrap the payload literal once here.
const budgetRead = (payload: DailyBudgetUiPayload): DailyBudgetUiRead => ({ kind: 'budget', payload });

describe('plan price widget payload', () => {
  test('renders the empty state when the host has no budget to report', () => {
    const payload = buildPlanPriceWidgetPayload({
      snapshot: { kind: 'unavailable' },
      combinedPrices: null,
      target: 'today',
    });

    expect(payload.state).toBe('empty');
  });

  test('builds a ready payload for today with actuals', () => {
    const day = buildDay(24);
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'today',
    });

    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') throw new Error('expected a ready payload');
    expect(payload.target).toBe('today');
    expect(payload.showActual).toBe(true);
    expect(payload.showNow).toBe(true);
    expect(payload.currentIndex).toBe(10);
    expect(payload.bucketLabels).toHaveLength(24);
    expect(payload.priceSeries[0]).toBe(75);
  });

  test('projects day totals, cost in kr, and an over-budget tone', () => {
    const day = buildDay(24);
    day.budget.dailyBudgetKWh = 1; // tiny budget → over.
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'today',
    });

    if (payload.state !== 'ready') throw new Error('expected ready payload');

    // Actual-to-date + planned-remainder basis (currentIndex 10):
    //   i < 10  → actual  (0.2 + i*0.01)
    //   i == 10 → max(actual 0.30, planned 0.35) = 0.35
    //   i > 10  → planned (0.25 + i*0.01)
    const expectedKwh = Array.from({ length: 24 }, (_v, i) => {
      const planned = 0.25 + (i * 0.01);
      if (i < 10) return 0.2 + (i * 0.01);
      if (i === 10) return Math.max(0.2 + (i * 0.01), planned);
      return planned;
    }).reduce((sum, v) => sum + v, 0);
    expect(payload.projectedKwh).toBeCloseTo(expectedKwh, 5);
    // Default Norwegian scheme: øre → kr (divide by 100).
    expect(payload.costUnit).toBe('kr');
    expect(payload.priceAxisUnit).toBe('øre/kWh');
    expect(payload.projectedCost).not.toBeNull();
    expect(payload.summaryTone).toBe('over');
  });

  test('projects actual usage to date plus planned remainder, flipping to over-budget on an overrun', () => {
    const day = buildDay(24);
    // 12 kWh budget; elapsed buckets 0–9 already burned 2 kWh each (20 kWh),
    // far past the budget, while the planned series alone stays under it.
    day.budget.dailyBudgetKWh = 12;
    day.currentBucketIndex = 10;
    day.buckets.plannedKWh = Array.from({ length: 24 }, () => 0.25);
    day.buckets.actualKWh = Array.from(
      { length: 24 },
      (_value, index) => (index < 10 ? 2 : 0),
    );

    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'today',
    });

    if (payload.state !== 'ready') throw new Error('expected ready payload');

    // 10 elapsed buckets × 2 kWh actual = 20, plus 14 remaining buckets
    // (current bucket 10 + future 11–23) × 0.25 planned = 3.5 → 23.5 kWh.
    expect(payload.projectedKwh).toBeCloseTo(20 + (14 * 0.25), 5);
    // Pure planned would be 24 × 0.25 = 6 kWh (under budget) — the actual basis
    // must dominate, so the tone is "over", never "on_track".
    expect(payload.summaryTone).toBe('over');
  });

  test('costs the projection on the actual-to-date basis, not pure planned', () => {
    const day = buildDay(24);
    day.budget.dailyBudgetKWh = 100;
    day.currentBucketIndex = 2;
    day.buckets.plannedKWh = Array.from({ length: 24 }, () => 1);
    // Elapsed buckets 0–1 used 5 kWh each (10 kWh actual) vs 1 kWh planned.
    day.buckets.actualKWh = Array.from(
      { length: 24 },
      (_value, index) => (index < 2 ? 5 : 0),
    );
    day.buckets.price = Array.from({ length: 24 }, () => 100); // 100 øre/kWh flat.

    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'today',
    });

    if (payload.state !== 'ready') throw new Error('expected ready payload');

    // Projection kWh: 2 elapsed × 5 + 22 remaining × 1 = 32 kWh.
    expect(payload.projectedKwh).toBeCloseTo(32, 5);
    // Cost = Σ price × kWh = 32 × 100 øre = 3200 øre → 32.00 kr.
    // Pure planned would have been 24 kWh → 24.00 kr, so the actual basis shows.
    expect(payload.projectedCost).toBeCloseTo(32, 5);
  });

  test('suppresses the projected cost on a partial price horizon (an energy bucket has no price)', () => {
    const day = buildDay(24);
    day.budget.dailyBudgetKWh = 100;
    day.currentBucketIndex = 0;
    day.buckets.plannedKWh = Array.from({ length: 24 }, () => 1);
    day.buckets.actualKWh = Array.from({ length: 24 }, () => 0);
    // Fully priced except one future energy-bearing bucket whose price is missing.
    day.buckets.price = Array.from({ length: 24 }, (_value, index) => (index === 12 ? null : 100));

    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'today',
    });

    if (payload.state !== 'ready') throw new Error('expected ready payload');

    // The kWh projection still stands (it does not depend on prices)...
    expect(payload.projectedKwh).toBeCloseTo(24, 5);
    // ...but a partial price horizon can't honestly read as a full-day total.
    expect(payload.projectedCost).toBeNull();
  });

  test('does not understate an in-progress bucket that has already overrun its allocation', () => {
    const day = buildDay(24);
    day.budget.dailyBudgetKWh = 100;
    day.currentBucketIndex = 0; // only the in-progress bucket so far.
    day.buckets.plannedKWh = Array.from({ length: 24 }, () => 1);
    // Current bucket already drew 9 kWh (vs 1 planned); rest future/zero.
    day.buckets.actualKWh = Array.from(
      { length: 24 },
      (_value, index) => (index === 0 ? 9 : 0),
    );

    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'today',
    });

    if (payload.state !== 'ready') throw new Error('expected ready payload');

    // Current bucket uses max(actual 9, planned 1) = 9, plus 23 future × 1.
    expect(payload.projectedKwh).toBeCloseTo(9 + 23, 5);
  });

  test('reports on-track tone when projected stays within budget', () => {
    const day = buildDay(24);
    day.budget.dailyBudgetKWh = 1000;
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'today',
    });

    if (payload.state !== 'ready') throw new Error('expected ready payload');
    expect(payload.summaryTone).toBe('on_track');
  });

  test('uses the flow scheme price unit and divisor 1 for cost', () => {
    const day = buildDay(24);
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: { prices: [], priceUnit: 'EUR' },
      target: 'today',
      priceScheme: 'flow',
    });

    if (payload.state !== 'ready') throw new Error('expected ready payload');
    expect(payload.costUnit).toBe('EUR');
    expect(payload.priceAxisUnit).toBe('EUR/kWh');
  });

  test('returns tomorrow empty state when no tomorrow plan exists', () => {
    const day = buildDay(24);
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'tomorrow',
    });

    expect(payload).toEqual({
      state: 'empty',
      target: 'tomorrow',
      title: 'Budget and Price',
      subtitle: "Tomorrow's budget not available yet",
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
      snapshot: budgetRead(snapshot),
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
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'tomorrow',
    });

    expect(payload.state).toBe('ready');
    if (payload.state !== 'ready') throw new Error('expected a ready payload');
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

  test('follows the planning price (budgetPrice) where a prosumer hour diverges', () => {
    const bucketStartUtc = [
      '2026-03-19T00:00:00.000Z',
      '2026-03-19T01:00:00.000Z',
    ];
    // Bucket prices carry the import total; the combined rows add the planning
    // price for the second hour (a surplus hour, cheaper). The first hour has no
    // budgetPrice → stays on the import total.
    const series = resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: [100, 200],
      combinedPrices: {
        prices: [
          { startsAt: bucketStartUtc[0], total: 100 },
          { startsAt: bucketStartUtc[1], total: 200, budgetPrice: 20 },
        ],
      },
    });
    expect(series).toEqual([100, 20]);
  });

  test('is byte-identical to the import price when no hour carries a budgetPrice', () => {
    const bucketStartUtc = [
      '2026-03-19T00:00:00.000Z',
      '2026-03-19T01:00:00.000Z',
    ];
    const withRows = resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: [100, 200],
      combinedPrices: {
        prices: [
          { startsAt: bucketStartUtc[0], total: 100 },
          { startsAt: bucketStartUtc[1], total: 200 },
        ],
      },
    });
    // A budgetPrice equal to total must not count as a divergence either.
    const withEqualBudgetPrice = resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: [100, 200],
      combinedPrices: {
        prices: [
          { startsAt: bucketStartUtc[0], total: 100, budgetPrice: 100 },
          { startsAt: bucketStartUtc[1], total: 200, budgetPrice: 200 },
        ],
      },
    });
    expect(withRows).toEqual([100, 200]);
    expect(withEqualBudgetPrice).toEqual([100, 200]);
  });

  test('projected cost is summed on the planning price for a prosumer', () => {
    const today = buildDay(2);
    today.buckets.plannedKWh = [1, 1];
    today.buckets.price = [100, 200];
    today.budget.enabled = true;
    today.budget.dailyBudgetKWh = 10;
    const snapshot: DailyBudgetUiPayload = {
      days: { [today.dateKey]: today },
      todayKey: today.dateKey,
    };
    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: {
        priceUnit: 'øre/kWh',
        prices: [
          { startsAt: today.buckets.startUtc[0], total: 100 },
          { startsAt: today.buckets.startUtc[1], total: 200, budgetPrice: 20 },
        ],
      },
      target: 'today',
      priceScheme: 'norway',
    });
    // Import cost would be (100 + 200) / 100 = 3.00 kr; planning drops the
    // surplus hour to (100 + 20) / 100 = 1.20 kr.
    expect(payload.state).toBe('ready');
    if (payload.state === 'ready') {
      expect(payload.priceSeries).toEqual([100, 20]);
      expect(payload.projectedCost).toBeCloseTo(1.2, 5);
    }
  });

  test('does not throw when combined_prices.prices is a malformed non-array (untrusted settings read)', () => {
    const bucketStartUtc = ['2026-03-19T00:00:00.000Z', '2026-03-19T01:00:00.000Z'];
    // A corrupt persisted `combined_prices` could carry a non-array `prices`.
    // The planning overlay must degrade to the import series, never throw.
    const series = resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: [100, 200],
      combinedPrices: { prices: 'garbage' as unknown as [] },
      divisor: 100,
    });
    expect(series).toEqual([100, 200]);
    // Same guard on the join fallback (misaligned bucket prices): a non-iterable
    // `{}` for `prices` must return nulls, not throw on `for...of`.
    expect(resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: [1],
      combinedPrices: { prices: {} as unknown as [] },
      divisor: 100,
    })).toEqual([null, null]);
  });

  test('handles empty price sources and invalid labels safely', () => {
    expect(resolvePriceSeries({
      bucketStartUtc: [],
      bucketPrices: [],
      combinedPrices: { prices: [{ startsAt: '2026-03-19T00:00:00.000Z', total: 123 }] },
    })).toEqual([]);

    expect(resolveLabel([], ['invalid-date'], 0)).toBe('');
    expect(resolveLabel([], [], 0)).toBe('');
  });

  test('resolves labels and intervals consistently', () => {
    expect(resolveLabel(['06:00', ''], ['2026-03-19T06:00:00.000Z', '2026-03-19T07:00:00.000Z'], 0)).toBe('06');
    expect(resolveLabel([':00'], [], 0)).toBe('');
    expect(resolveLabelEvery(24)).toBe(4);
    expect(resolveWidgetTarget('tomorrow')).toBe('tomorrow');
    expect(resolveWidgetTarget('unexpected')).toBe('today');
  });

  test('returns tomorrow pending when tomorrow exists but has no generated buckets yet', () => {
    const today = buildDay(24);
    const tomorrow = buildDay(0);
    tomorrow.dateKey = '2026-03-20';
    tomorrow.budget.enabled = true;

    const snapshot: DailyBudgetUiPayload = {
      days: {
        [today.dateKey]: today,
        [tomorrow.dateKey]: tomorrow,
      },
      todayKey: today.dateKey,
      tomorrowKey: tomorrow.dateKey,
    };

    const payload = buildPlanPriceWidgetPayload({
      snapshot: budgetRead(snapshot),
      combinedPrices: null,
      target: 'tomorrow',
    });

    expect(payload).toEqual({
      state: 'empty',
      target: 'tomorrow',
      title: 'Budget and Price',
      subtitle: "Tomorrow's budget not available yet",
    });
  });
});
