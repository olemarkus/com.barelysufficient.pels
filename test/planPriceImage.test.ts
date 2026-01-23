import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import { buildPlanPriceSvg } from '../lib/insights/planPriceImage';
import {
  buildMetaLines,
  buildPricePath,
  formatNumber,
  normalizeSeriesLength,
  resolveCurrentPlanInfo,
  resolveLabel,
  resolveLabelEvery,
  resolvePriceSeries,
} from '../lib/insights/planPriceImageUtils';

const buildDay = (bucketCount: number): DailyBudgetDayPayload => {
  const startUtc = Array.from({ length: bucketCount }, (_, index) => (
    new Date(Date.UTC(2025, 2, 30, index, 0, 0, 0)).toISOString()
  ));
  const zeros = Array.from({ length: bucketCount }, () => 0);
  return {
    dateKey: '2025-03-30',
    timeZone: 'Europe/Oslo',
    nowUtc: '2025-03-30T00:00:00.000Z',
    dayStartUtc: '2025-03-30T00:00:00.000Z',
    currentBucketIndex: 0,
    budget: {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
    },
    state: {
      usedNowKWh: 0,
      allowedNowKWh: 0,
      remainingKWh: 10,
      deviationKWh: 0,
      exceeded: false,
      frozen: false,
      confidence: 1,
      priceShapingActive: false,
    },
    buckets: {
      startUtc,
      startLocalLabels: [],
      plannedWeight: zeros,
      plannedKWh: Array.from({ length: bucketCount }, () => 1),
      actualKWh: zeros,
      allowedCumKWh: zeros,
    },
  };
};

describe('plan price image', () => {
  test('renders empty state when snapshot is missing', () => {
    const svg = buildPlanPriceSvg({ snapshot: null });
    expect(svg).toContain('Budget and Price');
    expect(svg).toContain('No plan data available');
  });

  test('renders disabled state when daily budget is off', () => {
    const day = buildDay(0);
    day.budget.enabled = false;
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };
    const svg = buildPlanPriceSvg({ snapshot, dayKey: day.dateKey });
    expect(svg).toContain('Daily budget disabled');
  });

  test('buildPricePath splits segments on missing price data', () => {
    const path = buildPricePath({
      priceSeries: [1, null, 3],
      chartLeft: 0,
      chartTop: 0,
      chartHeight: 100,
      slotWidth: 10,
      priceMin: 0,
      priceSpan: 10,
    });
    const moves = (path.match(/M/g) ?? []).length;
    expect(moves).toBe(2);
  });

  test('renders all buckets for DST-length day (23 hours)', () => {
    const day = buildDay(23);
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };
    const svg = buildPlanPriceSvg({ snapshot, dayKey: day.dateKey });
    const barCount = (svg.match(/rx="4"/g) ?? []).length;
    expect(barCount).toBe(23);
  });
});

describe('plan price image utils', () => {
  test('resolvePriceSeries prefers bucket prices when aligned', () => {
    const bucketStartUtc = [
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T01:00:00.000Z',
    ];
    const series = resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: [10, Number.NaN],
      combinedPrices: {
        prices: [
          { startsAt: bucketStartUtc[0], total: 200 },
          { startsAt: bucketStartUtc[1], total: 300 },
        ],
      },
    });
    expect(series).toEqual([10, null]);
  });

  test('resolvePriceSeries falls back to combined prices with gaps', () => {
    const bucketStartUtc = [
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T01:00:00.000Z',
    ];
    const series = resolvePriceSeries({
      bucketStartUtc,
      bucketPrices: [1],
      combinedPrices: {
        prices: [{ startsAt: bucketStartUtc[0], total: 42 }],
      },
    });
    expect(series).toEqual([42, null]);
  });

  test('normalizeSeriesLength pads with nulls', () => {
    expect(normalizeSeriesLength([1], 3)).toEqual([1, null, null]);
    expect(normalizeSeriesLength([1, null], 2)).toEqual([1, null]);
  });

  test('resolveLabel falls back to startUtc when label missing', () => {
    const labels = ['06:00', ''];
    const startUtc = ['2025-01-01T06:00:00.000Z', '2025-01-01T07:00:00.000Z'];
    const expectedSecond = String(new Date(startUtc[1]).getHours()).padStart(2, '0');
    expect(resolveLabel(labels, startUtc, 0)).toBe('06');
    expect(resolveLabel(labels, startUtc, 1)).toBe(expectedSecond);
    expect(resolveLabel([], ['invalid'], 0)).toBe('');
  });

  test('resolveLabelEvery adapts to bucket count', () => {
    expect(resolveLabelEvery(6)).toBe(1);
    expect(resolveLabelEvery(10)).toBe(2);
    expect(resolveLabelEvery(20)).toBe(4);
    expect(resolveLabelEvery(30)).toBe(5);
  });

  test('resolveCurrentPlanInfo clamps out-of-range index', () => {
    const current = resolveCurrentPlanInfo({
      day: { currentBucketIndex: 99 } as DailyBudgetDayPayload,
      plannedKWh: [1, 2, 3, 4],
      priceSeries: [1, 2, 3, 4],
      bucketLabels: [],
      bucketStartUtc: ['2025-01-01T00:00:00.000Z'],
      bucketCount: 4,
      isToday: true,
      priceUnit: 'øre/kWh',
    });
    expect(current.currentIndex).toBe(3);
    expect(current.showNow).toBe(false);
  });

  test('buildMetaLines marks tomorrow and pending prices', () => {
    const { metaLine, nowLine } = buildMetaLines({
      day: { dateKey: '2025-01-02' } as DailyBudgetDayPayload,
      currentPlan: 1,
      currentPriceLabel: 'Price n/a',
      isToday: false,
      hasPriceData: false,
      showNow: false,
    });
    expect(metaLine).toContain('2025-01-02');
    expect(metaLine).toContain('Tomorrow');
    expect(metaLine).toContain('Prices pending');
    expect(nowLine).toContain('Plan preview');
  });

  test('formatNumber handles non-finite values', () => {
    expect(formatNumber(Number.NaN, 2)).toBe('--');
    expect(formatNumber(1.2345, 2)).toBe('1.23');
  });
});
