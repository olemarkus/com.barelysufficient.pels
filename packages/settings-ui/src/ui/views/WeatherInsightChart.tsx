import { encodeHtml, useEchartsMount, type EChartsOption, type SeriesOption } from '../echartsRegistry.ts';
import type {
  EnergySignatureFit,
  WeatherAdvisorPrediction,
  WeatherCoverageBin,
  WeatherRecentDay,
  WeatherScatterBin,
} from '../../../../contracts/src/weatherAdvisorTypes.ts';
import { predictDailyKwh } from '../../../../shared-domain/src/energySignature/energySignature.ts';
import {
  composeBalanceTickLabel,
  composeBalanceTooltip,
  composeBinTooltip,
  composeCoverageCaption,
  composeDayDotTooltip,
  composeTomorrowDotTooltip,
  formatTempC,
  WEATHER_COVERAGE_LEGEND,
} from '../../../../shared-domain/src/weatherInsightCopy.ts';

// Scatter + fit line + balance tick + tomorrow dot for the Weather insight
// detail view, plus the HTML coverage band below it. Follows the DeadlinePlan
// chart idiom: token palette read off the live container, `useEchartsMount`
// lifecycle, `buildWeatherChartOption` exported pure for unit tests (echarts
// is shimmed in jsdom). Marker grammar (notes/weather-insight-spec.md §5):
// solid dot = actual, hollow dot = projected, line = estimate, thin tick =
// threshold. The balance tick is a line SERIES, not a markLine, by design.

export type WeatherChartPalette = {
  accent: string;
  muted: string;
  grid: string;
  text: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

const cssVar = (element: HTMLElement, variable: string, fallback = ''): string => (
  getComputedStyle(element).getPropertyValue(variable).trim() || fallback
);

const cssNumber = (element: HTMLElement, variable: string, fallback: number): number => {
  const parsed = Number.parseFloat(cssVar(element, variable));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolveWeatherPalette = (element: HTMLElement): WeatherChartPalette => ({
  accent: cssVar(element, '--color-role-accent'),
  muted: cssVar(element, '--pels-text-supporting-color'),
  grid: cssVar(element, '--pels-surface-outline'),
  text: cssVar(element, '--text'),
  tooltipBackground: cssVar(element, '--color-overlay-toast'),
  tooltipText: cssVar(element, '--color-semantic-text-primary'),
  tooltipBorder: cssVar(element, '--color-border-medium'),
});

// Must match `.weather-insight-chart` height in style.css (cold-mount fallback).
const WEATHER_CHART_HEIGHT = 220;
const resolveWeatherChartSize = (element: HTMLElement): { height: number; width: number } => {
  const width = element.clientWidth > 0 ? element.clientWidth : (element.parentElement?.clientWidth ?? 390);
  return {
    width: width > 0 ? width : 390,
    height: element.clientHeight > 0 ? element.clientHeight : WEATHER_CHART_HEIGHT,
  };
};

export type WeatherChartOptionInput = {
  scatter: WeatherScatterBin[];
  recentDays: WeatherRecentDay[];
  fit: EnergySignatureFit | null;
  prediction: WeatherAdvisorPrediction | null;
  /** Largest solid dot (marker grammar: yesterday is the freshest actual). */
  yesterdayDateKey: string | null;
  palette: WeatherChartPalette;
  labelFontSize: number;
};

const RECENT_ACCENT_DAYS = 14;
const QUALITY_DIMMED_OPACITY = 0.15;

const roundDownTo = (value: number, step: number): number => Math.floor(value / step) * step;
const roundUpTo = (value: number, step: number): number => Math.ceil(value / step) * step;

/** Count-weighted bin symbol: √-scaled so dense bins read heavier, capped for touch. */
const binSymbolSize = (count: number): number => Math.min(16, 6 + Math.sqrt(count) * 2);

type ScatterDatum = Record<string, unknown>;

const isPartialQuality = (day: WeatherRecentDay): boolean => (
  day.quality.partialTemp || day.quality.unreliablePower
);

const buildRecentDayData = (
  recentDays: WeatherRecentDay[],
  yesterdayDateKey: string | null,
  palette: WeatherChartPalette,
): ScatterDatum[] => {
  const accentCutoffIndex = Math.max(0, recentDays.length - RECENT_ACCENT_DAYS);
  return recentDays.map((day, index) => {
    const isRecent = index >= accentCutoffIndex;
    const isYesterday = day.dateKey === yesterdayDateKey;
    const partial = isPartialQuality(day);
    const opacity = partial ? QUALITY_DIMMED_OPACITY : (isRecent ? 1 : 0.35);
    return {
      value: [day.tempMeanC, day.kwhTotal],
      dateKey: day.dateKey,
      partial,
      symbolSize: isYesterday ? 9 : 5,
      itemStyle: {
        color: isRecent && !partial ? palette.accent : palette.muted,
        opacity,
      },
    };
  });
};

/**
 * Estimate line sampled from the fit, never extrapolated past the observed
 * range: changepoint = sloped-then-flat (the knee at the balance point),
 * winter-only linear = sloped segment only, uncorrelated = no line at all
 * (a flat cloud is self-explanatory — spec S5).
 */
const buildFitLinePoints = (fit: EnergySignatureFit | null): Array<[number, number]> => {
  if (!fit || fit.model === 'uncorrelated') return [];
  const minT = fit.observedTempMinC;
  const maxT = fit.observedTempMaxC;
  const at = (tempC: number): [number, number] => [tempC, predictDailyKwh(fit, tempC) ?? fit.medianDayKwh];
  if (fit.model === 'changepoint' && fit.balancePointC !== undefined
    && fit.balancePointC > minT && fit.balancePointC < maxT) {
    return [at(minT), at(fit.balancePointC), at(maxT)];
  }
  return [at(minT), at(maxT)];
};

export const buildWeatherChartOption = (input: WeatherChartOptionInput): EChartsOption => {
  const { scatter, recentDays, fit, prediction, palette, labelFontSize } = input;
  const fitLine = buildFitLinePoints(fit);
  const temps = [
    ...scatter.map((bin) => bin.tempBinC),
    ...recentDays.map((day) => day.tempMeanC),
    ...(prediction ? [prediction.tempMeanC] : []),
  ];
  const kwhs = [
    ...scatter.map((bin) => bin.kwhMedian),
    ...recentDays.map((day) => day.kwhTotal),
    ...fitLine.map(([, kwh]) => kwh),
    ...(prediction ? [prediction.highKwh] : []),
  ];
  const xMin = roundDownTo((temps.length ? Math.min(...temps) : 0) - 1, 5);
  const xMax = roundUpTo((temps.length ? Math.max(...temps) : 20) + 1, 5);
  const yMax = Math.max(10, roundUpTo((kwhs.length ? Math.max(...kwhs) : 10) * 1.05, 10));
  const tickTopKwh = yMax * 0.08;
  const balanceTickC = fit?.model === 'changepoint' && fit.balancePointC !== undefined
    ? fit.balancePointC
    : null;

  const series: SeriesOption[] = [
    {
      id: 'bins',
      type: 'scatter',
      data: scatter.map((bin) => ({
        value: [bin.tempBinC, bin.kwhMedian, bin.count],
        binQ1: bin.kwhQ1,
        binQ3: bin.kwhQ3,
      })),
      symbolSize: (value: number[]) => binSymbolSize(value[2] ?? 1),
      itemStyle: { color: palette.text, opacity: 0.35 },
      tooltip: {
        formatter: (params: { data: ScatterDatum }) => encodeHtml(composeBinTooltip({
          tempBinC: (params.data.value as number[])[0],
          kwhQ1: params.data.binQ1 as number,
          kwhQ3: params.data.binQ3 as number,
          count: (params.data.value as number[])[2],
        })),
      },
    },
    {
      id: 'recent',
      type: 'scatter',
      data: buildRecentDayData(recentDays, input.yesterdayDateKey, palette),
      tooltip: {
        formatter: (params: { data: ScatterDatum }) => encodeHtml(composeDayDotTooltip({
          dateKey: params.data.dateKey as string,
          tempMeanC: (params.data.value as number[])[0],
          kwhTotal: (params.data.value as number[])[1],
          partial: params.data.partial as boolean,
        })),
      },
    },
    ...(fitLine.length > 0 ? [{
      id: 'fit',
      type: 'line',
      data: fitLine,
      silent: true,
      symbol: 'none',
      lineStyle: { color: palette.accent, width: 2 },
      tooltip: { show: false },
    } satisfies SeriesOption] : []),
    ...(balanceTickC !== null ? [{
      id: 'balance-tick',
      type: 'line',
      symbol: 'none',
      lineStyle: { color: palette.muted, width: 1 },
      data: [
        { value: [balanceTickC, 0] },
        {
          value: [balanceTickC, tickTopKwh],
          label: {
            show: true,
            position: 'top' as const,
            formatter: () => composeBalanceTickLabel(balanceTickC),
            color: palette.muted,
            fontSize: labelFontSize,
          },
        },
      ],
      tooltip: {
        formatter: () => encodeHtml(composeBalanceTooltip(balanceTickC)),
      },
    } satisfies SeriesOption] : []),
    ...(prediction ? [{
      id: 'tomorrow',
      type: 'scatter',
      data: [[prediction.tempMeanC, prediction.kwh]],
      symbol: 'emptyCircle',
      symbolSize: 11,
      itemStyle: { color: 'transparent', borderColor: palette.accent, borderWidth: 2 },
      tooltip: {
        formatter: () => encodeHtml(composeTomorrowDotTooltip({
          tempMeanC: prediction.tempMeanC,
          lowKwh: prediction.lowKwh,
          highKwh: prediction.highKwh,
        })),
      },
    } satisfies SeriesOption] : []),
  ];

  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    grid: { left: 8, right: 16, top: 20, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'item',
      appendToBody: true,
      confine: true,
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.tooltipText },
    },
    xAxis: {
      type: 'value',
      min: xMin,
      max: xMax,
      interval: 5,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.grid } },
      splitLine: { show: false },
      axisLabel: {
        color: palette.muted,
        fontSize: labelFontSize,
        // Degree-only labels every 10 °C (`−10°  0°  10°`) — the full unit
        // lives in the card title and the coverage-band labels.
        formatter: (value: number) => (
          value % 10 === 0 ? `${value < 0 ? '−' : ''}${Math.abs(value)}°` : ''
        ),
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yMax,
      splitNumber: 3,
      splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.muted, fontSize: labelFontSize },
    },
    series,
  };
};

export type WeatherScatterChartProps = {
  scatter: WeatherScatterBin[];
  recentDays: WeatherRecentDay[];
  fit: EnergySignatureFit | null;
  prediction: WeatherAdvisorPrediction | null;
  yesterdayDateKey: string | null;
};

export const WeatherScatterChart = (props: WeatherScatterChartProps) => {
  const { scatter, recentDays, fit, prediction, yesterdayDateKey } = props;
  const chartRef = useEchartsMount({
    buildOption: (container) => buildWeatherChartOption({
      scatter,
      recentDays,
      fit,
      prediction,
      yesterdayDateKey,
      palette: resolveWeatherPalette(container),
      labelFontSize: cssNumber(container, '--font-size-xs', 11),
    }),
    resolveSize: resolveWeatherChartSize,
    deps: [scatter, recentDays, fit, prediction, yesterdayDateKey],
  });
  return (
    <div
      id="weather-insight-chart"
      class="weather-insight-chart"
      ref={chartRef}
      role="img"
      aria-label="Daily usage by outside temperature"
    />
  );
};

// ─── Coverage band (HTML, not a chart) ────────────────────────────────────────

const shadeFor = (bin: WeatherCoverageBin): string => {
  if (bin.sufficient) return 'solid';
  return bin.days >= 4 ? 'light' : 'outline';
};

export const WeatherCoverageBand = ({
  coverage,
  tomorrowTempC,
}: {
  coverage: WeatherCoverageBin[];
  tomorrowTempC: number | null;
}) => {
  if (coverage.length === 0) return null;
  const minC = coverage[0].fromC;
  const maxC = coverage[coverage.length - 1].toC;
  const caption = composeCoverageCaption(coverage);
  const dotPct = tomorrowTempC !== null && maxC > minC
    ? Math.min(100, Math.max(0, ((tomorrowTempC - minC) / (maxC - minC)) * 100))
    : null;
  return (
    <div id="weather-coverage-band" class="weather-coverage">
      <div
        class="weather-coverage__track"
        style={dotPct !== null ? { '--weather-coverage-dot-x': `${dotPct.toFixed(1)}%` } : undefined}
      >
        {coverage.map((bin) => (
          <span
            key={bin.fromC}
            class={`weather-coverage__bin weather-coverage__bin--${shadeFor(bin)}`}
            title={`${formatTempC(bin.fromC)} to ${formatTempC(bin.toC)}`}
          />
        ))}
        {dotPct !== null && <span class="weather-coverage__dot" aria-hidden="true" />}
      </div>
      <div class="weather-coverage__labels">
        <span>{formatTempC(minC)}</span>
        <span>{formatTempC(maxC)}</span>
      </div>
      {caption !== '' && <p class="pels-card-supporting weather-coverage__caption">{caption}</p>}
      <p class="pels-card-supporting weather-coverage__caption">{WEATHER_COVERAGE_LEGEND}</p>
    </div>
  );
};
