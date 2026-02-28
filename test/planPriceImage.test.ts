import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../lib/dailyBudget/dailyBudgetTypes';
import { buildPlanPriceSvgWithEcharts } from '../lib/insights/planPriceImageEcharts';
import { listRuntimeSpans } from '../lib/utils/runtimeTrace';
import {
  buildLegendTexts,
  buildMetaLines,
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
  test('renders empty state when snapshot is missing', async () => {
    const svg = await buildPlanPriceSvgWithEcharts({
      snapshot: null,
      width: 900,
      height: 900,
      fontFamily: 'sans-serif',
    });
    expect(svg).toContain('Budget and Price');
    expect(svg).toContain('No plan data available');
  });

  test('stops the camera runtime span for empty-state renders', async () => {
    await buildPlanPriceSvgWithEcharts({
      snapshot: null,
      width: 900,
      height: 900,
      fontFamily: 'sans-serif',
    });

    expect(listRuntimeSpans(32).filter((span) => span.startsWith('camera_svg_echarts'))).toHaveLength(0);
  });

  test('renders disabled state when daily budget is off', async () => {
    const day = buildDay(0);
    day.budget.enabled = false;
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };
    const svg = await buildPlanPriceSvgWithEcharts({
      snapshot,
      dayKey: day.dateKey,
      width: 900,
      height: 900,
      fontFamily: 'sans-serif',
    });
    expect(svg).toContain('Daily budget disabled');
  });

  test('renders all buckets for DST-length day (23 hours)', async () => {
    const day = buildDay(23);
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };
    const svg = await buildPlanPriceSvgWithEcharts({
      snapshot,
      dayKey: day.dateKey,
      width: 900,
      height: 900,
      fontFamily: 'sans-serif',
    });
    expect(svg).toContain('<svg');
  });

  test('renders SVG with echarts engine', async () => {
    const day = buildDay(8);
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };
    const svg = await buildPlanPriceSvgWithEcharts({
      snapshot,
      dayKey: day.dateKey,
      width: 900,
      height: 900,
      fontFamily: 'sans-serif',
    });
    expect(svg).toContain('<svg');
    expect(svg).toContain('Plan');
  });

  test('uses simplified legend labels', async () => {
    const day = buildDay(8);
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };
    const svg = await buildPlanPriceSvgWithEcharts({
      snapshot,
      dayKey: day.dateKey,
      width: 900,
      height: 900,
      fontFamily: 'sans-serif',
    });

    expect(svg).toContain('Plan');
    expect(svg).toContain('Price');
  });

  test('shows Actual legend for today camera chart', async () => {
    const day = buildDay(8);
    day.buckets.actualKWh = [0.8, 1.1, 0.9, 1.4, 0, 0, 0, 0];
    day.currentBucketIndex = 3;
    const snapshot: DailyBudgetUiPayload = {
      days: { [day.dateKey]: day },
      todayKey: day.dateKey,
    };
    const svg = await buildPlanPriceSvgWithEcharts({
      snapshot,
      dayKey: day.dateKey,
      width: 900,
      height: 900,
      fontFamily: 'sans-serif',
    });
    expect(svg).toContain('Actual');
  });

  test('hides Actual legend for non-today camera chart', async () => {
    const today = buildDay(8);
    today.dateKey = '2025-03-29';
    today.dayStartUtc = '2025-03-29T00:00:00.000Z';
    today.nowUtc = '2025-03-29T12:00:00.000Z';

    const tomorrow = buildDay(8);
    tomorrow.dateKey = '2025-03-30';
    tomorrow.dayStartUtc = '2025-03-30T00:00:00.000Z';
    tomorrow.nowUtc = '2025-03-30T12:00:00.000Z';
    tomorrow.buckets.actualKWh = [1, 1, 1, 1, 1, 1, 1, 1];
    const snapshot: DailyBudgetUiPayload = {
      days: {
        [today.dateKey]: today,
        [tomorrow.dateKey]: tomorrow,
      },
      todayKey: today.dateKey,
      tomorrowKey: tomorrow.dateKey,
    };
    const svg = await buildPlanPriceSvgWithEcharts({
      snapshot,
      dayKey: tomorrow.dateKey,
      width: 900,
      height: 900,
      fontFamily: 'sans-serif',
    });
    expect(svg).not.toContain('Actual');
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

  test('buildLegendTexts returns simple series labels', () => {
    const legend = buildLegendTexts();
    expect(legend.plan).toBe('Plan');
    expect(legend.price).toBe('Price');
  });

  test('formatNumber handles non-finite values', () => {
    expect(formatNumber(Number.NaN, 2)).toBe('--');
    expect(formatNumber(1.2345, 2)).toBe('1.23');
  });
});
