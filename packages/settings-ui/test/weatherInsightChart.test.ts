import { describe, expect, it } from 'vitest';
import {
  buildWeatherChartOption,
  type WeatherChartOptionInput,
  type WeatherChartPalette,
} from '../src/ui/views/WeatherInsightChart.tsx';
import type { EnergySignatureFit } from '../../contracts/src/weatherAdvisorTypes';

/* -------------------------------------------------------------------------- *
 * Pure option-builder tests (no echarts mount): series composition follows
 * the marker grammar — binned scatter (count-weighted), raw recent overlay,
 * estimate line shaped sloped-then-flat at the balance point, balance tick as
 * a LINE SERIES (markLine is deliberately avoided), tomorrow as a hollow dot.
 * -------------------------------------------------------------------------- */

const palette: WeatherChartPalette = {
  accent: '#7fd1ae',
  muted: '#9aa3ad',
  grid: '#3a4555',
  text: '#f2f4f7',
  tooltipBackground: '#000000',
  tooltipText: '#ffffff',
  tooltipBorder: '#3a4555',
};

const fit = (overrides: Partial<EnergySignatureFit> = {}): EnergySignatureFit => ({
  model: 'changepoint',
  baseLoadKwhPerDay: 23,
  slopeKwhPerDegree: 1.8,
  balancePointC: 13,
  pseudoR2: 0.7,
  usableDays: 120,
  observedTempMinC: -10,
  observedTempMaxC: 22,
  medianDayKwh: 38,
  lowObservedDayKwh: 20,
  confidence: 'high',
  curvatureSteeperWhenCold: false,
  driftSuspected: false,
  suppressedDaysExcluded: 0,
  suppressionFilterRelaxed: false,
  recentColdSuppressionSuspected: false,
  residualQ10: -4,
  residualQ50: 0,
  residualQ80: 4,
  residualQ90: 6,
  fittedAtMs: 0,
  ...overrides,
});

const baseInput = (overrides: Partial<WeatherChartOptionInput> = {}): WeatherChartOptionInput => ({
  scatter: [
    { tempBinC: -5, kwhMedian: 55, kwhQ1: 50, kwhQ3: 60, count: 4 },
    { tempBinC: 5, kwhMedian: 37, kwhQ1: 34, kwhQ3: 41, count: 16 },
  ],
  recentDays: [
    {
      dateKey: '2026-06-10',
      tempMeanC: 3,
      kwhTotal: 47,
      quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
    },
  ],
  fit: fit(),
  prediction: {
    tempMeanC: 2,
    kwh: 42.8,
    lowKwh: 38,
    highKwh: 50,
    beyondObservedCold: false,
    beyondObservedWarm: false,
  },
  yesterdayDateKey: '2026-06-10',
  palette,
  labelFontSize: 11,
  ...overrides,
});

type SeriesLike = { id: string; type: string; data: unknown[] };

const seriesById = (option: Record<string, unknown>, id: string): SeriesLike | undefined => (
  (option.series as SeriesLike[]).find((series) => series.id === id)
);

describe('buildWeatherChartOption', () => {
  it('renders bins + recent + fit line + balance tick + tomorrow dot when ready', () => {
    const option = buildWeatherChartOption(baseInput());
    const ids = (option.series as SeriesLike[]).map((series) => series.id);
    expect(ids).toEqual(['bins', 'recent', 'fit', 'balance-tick', 'tomorrow']);
  });

  it('shapes the changepoint estimate line sloped-then-flat through the knee', () => {
    const option = buildWeatherChartOption(baseInput());
    const fitSeries = seriesById(option, 'fit');
    // Three points: coldest observed → balance point → warmest observed.
    expect(fitSeries?.data).toEqual([
      [-10, 23 + 1.8 * 23],
      [13, 23],
      [22, 23],
    ]);
  });

  it('uses a line series (not markLine) for the balance tick', () => {
    const option = buildWeatherChartOption(baseInput());
    const tick = seriesById(option, 'balance-tick');
    expect(tick?.type).toBe('line');
    expect(JSON.stringify(option)).not.toContain('markLine');
    const xs = (tick?.data as Array<{ value: number[] }>).map((point) => point.value[0]);
    expect(xs).toEqual([13, 13]);
  });

  it('winter-only (linear) fit draws a sloped segment only, no flat part, no tick', () => {
    const option = buildWeatherChartOption(baseInput({
      fit: fit({ model: 'linear', interceptKwhAtZeroC: 52, slopeKwhPerDegree: 2.1, balancePointC: undefined, baseLoadKwhPerDay: undefined }),
    }));
    expect(seriesById(option, 'fit')?.data).toHaveLength(2);
    expect(seriesById(option, 'balance-tick')).toBeUndefined();
  });

  it('uncorrelated homes get no estimate line at all (flat cloud speaks for itself)', () => {
    const option = buildWeatherChartOption(baseInput({ fit: fit({ model: 'uncorrelated' }) }));
    expect(seriesById(option, 'fit')).toBeUndefined();
    expect(seriesById(option, 'balance-tick')).toBeUndefined();
  });

  it('renders tomorrow as a hollow dot at the forecast temperature', () => {
    const option = buildWeatherChartOption(baseInput());
    const tomorrow = seriesById(option, 'tomorrow') as SeriesLike & { symbol: string };
    expect(tomorrow.symbol).toBe('emptyCircle');
    expect(tomorrow.data).toEqual([[2, 42.8]]);
  });

  it('dims quality-flagged days and accents the recent window with yesterday largest', () => {
    const option = buildWeatherChartOption(baseInput({
      recentDays: [
        {
          dateKey: '2026-06-01',
          tempMeanC: 6,
          kwhTotal: 35,
          quality: { partialTemp: true, missingKwh: false, unreliablePower: false, backfilled: false },
        },
        {
          dateKey: '2026-06-10',
          tempMeanC: 3,
          kwhTotal: 47,
          quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
        },
      ],
    }));
    const recent = seriesById(option, 'recent');
    const [partialDay, yesterday] = recent?.data as Array<{
      symbolSize: number;
      itemStyle: { opacity: number; color: string };
    }>;
    expect(partialDay.itemStyle.opacity).toBeCloseTo(0.15, 5);
    expect(yesterday.symbolSize).toBeGreaterThan(partialDay.symbolSize);
    expect(yesterday.itemStyle.color).toBe(palette.accent);
  });

  it('labels the temperature axis only at 10° multiples with a U+2212 minus', () => {
    const option = buildWeatherChartOption(baseInput());
    const axis = option.xAxis as { axisLabel: { formatter: (value: number) => string } };
    expect(axis.axisLabel.formatter(-10)).toBe('−10°');
    expect(axis.axisLabel.formatter(0)).toBe('0°');
    expect(axis.axisLabel.formatter(5)).toBe('');
  });
});
