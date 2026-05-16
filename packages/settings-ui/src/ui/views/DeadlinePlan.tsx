import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { DeferredObjectiveSettingsKind } from '../../../../contracts/src/deferredObjectiveSettings.ts';
import type { DeferredObjectiveActivePlanRevisionReason } from '../../../../contracts/src/deferredObjectiveActivePlans.ts';
import {
  deadlineLabels,
  type DeadlineLabels,
  type DeadlinePlanUnavailableReason,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { encodeHtml, initEcharts, type EChartsOption, type EChartsType, type SeriesOption } from '../echartsRegistry.ts';
import { attachTabShownResize } from '../chartVisibilityResize.ts';
import type { DeadlinePlanHistoryView } from '../deadlinePlanHistoryFetch.ts';
import type { DeferredObjectivePlanHistoryEntry } from '../../../../contracts/src/deferredObjectivePlanHistory.ts';
import { DeadlinePlanHistoryDetail } from './DeadlinePlanHistoryDetail.tsx';
import { MdTextButton } from './materialWebJSX.tsx';

// Matches the `.plan-chip--*` CSS variants in
// `packages/settings-ui/public/style.css` (~1340-1374). `alert` was previously
// styled but unreferenced; surfacing it lets the cannot-finish chip use the
// same critical (red) tone as the hero rim instead of a warning (amber) tone
// that contradicted it.
type DeadlinePlanChipTone = 'alert' | 'info' | 'muted' | 'ok' | 'warn';
type DeadlinePlanHourTone = 'cheap' | 'expensive' | 'normal';

// Maps to the CSS `[data-tone="…"]` rim/background variants on `.pels-hero` /
// `.plan-hero` (style.css ~1287-1325). `good` is the on-track / satisfied
// state, `warn` covers at-risk, `alert` covers cannot-meet, `info` is the
// neutral pending hero. Keep this union in sync with the CSS bindings — a
// rim that never paints is worse than no rim at all.
export type DeadlinePlanHeroTone = 'good' | 'warn' | 'alert' | 'info';

type DeadlinePlanChip = {
  text: string;
  tone: DeadlinePlanChipTone;
};

type DeadlinePlanHour = {
  time: string;
  price: string;
  priceValue: number;
  tone: DeadlinePlanHourTone;
  planned: boolean;
  changed: boolean;
  // Populated on changed hours from the latest revision's reason; null otherwise.
  revisionReason: DeferredObjectiveActivePlanRevisionReason | null;
  usage: {
    backgroundKwh: number;
    originalDeviceKwh: number;
    deviceKwh: number;
    actualDeviceKwh: number | null;
  };
  progress: number;
};

export type DeadlinePlanPayload = {
  kind: DeferredObjectiveSettingsKind;
  labels: DeadlineLabels;
  // Axis/tooltip label for hourly prices. Prices are already scaled to this
  // unit (e.g. divided by 100 to convert øre → kr/kWh) by the producer so the
  // chart renders raw display values; the Budget chart uses the same
  // CostDisplay so both surfaces show identical numbers.
  priceUnitLabel: string;
  hero: {
    chips: DeadlinePlanChip[];
    // Resolved at the producer (`deadlinePlan.ts`) from the active plan's
    // `planStatus` so the view never branches on planner internals. Keeps
    // chip text, rim colour, and meta line agreeing on a single "are we ok?"
    // signal.
    tone: DeadlinePlanHeroTone;
    sectionLabel: string;
    headline: string;
    subline: string;
    metaLine: string;
  };
  timeline: {
    ariaLabel: string;
    progressFloor: number;
    progressCeilingValue: number;
    progressCeilingLabel: string;
    deadlineLabel: string;
    hours: DeadlinePlanHour[];
  };
  planInputs: {
    perUnitRateLabel: string | null;
    perUnitRateNote: string | null;
    maxPowerLabel: string | null;
  };
};

export type { DeadlinePlanHistoryView } from '../deadlinePlanHistoryFetch.ts';

export type DeadlinePlanPendingPayload = {
  kind: DeferredObjectiveSettingsKind;
  labels: DeadlineLabels;
  hero: {
    chips: DeadlinePlanChip[];
    sectionLabel: string;
    headline: string;
    subline: string;
    metaLine: string;
  };
};

export type DeadlinePlanLoadState =
  | { status: 'error'; message: string; onRetry?: () => void; history?: DeadlinePlanHistoryView }
  | { status: 'loading'; history?: DeadlinePlanHistoryView }
  | { status: 'pending'; pending: DeadlinePlanPendingPayload; history?: DeadlinePlanHistoryView }
  | {
    status: 'unavailable';
    objectiveKind: DeferredObjectiveSettingsKind;
    reason: DeadlinePlanUnavailableReason;
    history?: DeadlinePlanHistoryView;
  }
  | {
    // Deadline has passed or the runtime auto-disabled the objective. The
    // root lands on the History tab so the user sees outcomes rather than
    // a stale current plan.
    status: 'completed';
    objectiveKind: DeferredObjectiveSettingsKind;
    history?: DeadlinePlanHistoryView;
  }
  | { status: 'ready'; payload: DeadlinePlanPayload; history?: DeadlinePlanHistoryView }
  | {
    // Detail view for a finalized plan in history. The page lands on the
    // History tab and shows the entry's recorded plan snapshots instead of
    // the live planner output.
    status: 'history-detail';
    entry: DeferredObjectivePlanHistoryEntry;
    timeZone: string;
    history?: DeadlinePlanHistoryView;
  }
  | {
    // The URL referenced a historyId that no longer exists (entry rolled off
    // the cap, or settings were cleared). Lands on History so the user can
    // see what is still available.
    status: 'history-missing';
    history?: DeadlinePlanHistoryView;
  };

const chipClass = (tone: DeadlinePlanChipTone): string => `plan-chip plan-chip--${tone}`;

const DeadlineHero = ({ payload }: { payload: DeadlinePlanPayload }) => (
  <section class="plan-hero pels-hero" data-tone={payload.hero.tone} aria-labelledby="deadline-plan-title">
    <div class="plan-hero__chips">
      {payload.hero.chips.map((chip) => (
        <span key={chip.text} class={chipClass(chip.tone)}>{chip.text}</span>
      ))}
    </div>
    <div class="plan-hero__section">
      <span class="plan-hero__section-label eyebrow" id="deadline-plan-title">{payload.hero.sectionLabel}</span>
      <div class="plan-hero__headline">{payload.hero.headline}</div>
      <div class="plan-hero__subline">{payload.hero.subline}</div>
      <div class="plan-hero__subline plan-hero__subline--muted">{payload.hero.metaLine}</div>
    </div>
  </section>
);

export type DeadlineChartPalette = {
  priceCheap: string;
  priceNormal: string;
  priceExpensive: string;
  background: string;
  device: string;
  actualDevice: string;
  progress: string;
  grid: string;
  text: string;
  muted: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

// `fallback` is consulted only when the computed value is empty (token missing
// or renamed). Tokens are committed alongside this code, so this is defense in
// depth rather than a normal code path.
const cssVar = (element: HTMLElement, variable: string, fallback = ''): string => (
  getComputedStyle(element).getPropertyValue(variable).trim() || fallback
);

const cssNumber = (element: HTMLElement, variable: string, fallback: number): number => {
  const raw = cssVar(element, variable);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const resolvePalette = (element: HTMLElement): DeadlineChartPalette => ({
  priceCheap: cssVar(element, '--pels-status-good-border'),
  priceNormal: cssVar(element, '--pels-surface-container-high'),
  priceExpensive: cssVar(element, '--color-base-warning-default'),
  background: cssVar(element, '--pels-text-supporting-color'),
  device: cssVar(element, '--color-base-accent-default'),
  actualDevice: cssVar(element, '--color-role-good'),
  progress: cssVar(element, '--color-base-info-default'),
  grid: cssVar(element, '--pels-surface-outline'),
  text: cssVar(element, '--text'),
  muted: cssVar(element, '--pels-text-supporting-color'),
  tooltipBackground: cssVar(element, '--color-overlay-toast'),
  tooltipText: cssVar(element, '--color-semantic-text-primary'),
  tooltipBorder: cssVar(element, '--color-border-medium'),
});

export type ChartTypography = {
  labelFontSize: number;
  axisNameFontSize: number;
  axisNameFontWeight: number;
};

const resolveTypography = (element: HTMLElement): ChartTypography => ({
  labelFontSize: cssNumber(element, '--font-size-xs', 11),
  axisNameFontSize: cssNumber(element, '--font-size-xs', 11),
  axisNameFontWeight: cssNumber(element, '--font-weight-bold', 700),
});

const resolveChartSize = (element: HTMLElement): { height: number; width: number } => {
  const width = element.clientWidth > 0 ? element.clientWidth : (element.parentElement?.clientWidth ?? 390);
  const viewportWidth = document.documentElement?.clientWidth ?? 0;
  return {
    width: width > 0 ? width : Math.min(480, viewportWidth || 390),
    // Default height matches `.deadline-horizon-chart` in style.css (240 px)
    // so a cold-mount inside a hidden panel sizes the chart consistently with
    // the post-resize value.
    height: element.clientHeight > 0 ? element.clientHeight : 240,
  };
};

const formatProgressValue = (value: number, unit: DeadlineLabels['targetUnit']): string => (
  unit === '°C' ? `${value.toFixed(1)} °C` : `${Math.round(value)}%`
);

const buildTooltip = (payload: DeadlinePlanPayload, rawParams: unknown): string => {
  const params = Array.isArray(rawParams) ? rawParams : [rawParams];
  const first = params.find((item): item is { dataIndex: number } => (
    Boolean(item) && typeof item === 'object' && Number.isInteger((item as { dataIndex?: unknown }).dataIndex)
  ));
  const hour = first ? payload.timeline.hours[first.dataIndex] : null;
  if (!hour) return '';
  const labels = payload.labels;
  const planLabel = hour.planned ? labels.planTooltipActive : labels.planTooltipIdle;
  const originalLine = hour.changed
    ? `${labels.originalDeviceSeriesName} ${hour.usage.originalDeviceKwh.toFixed(1)} kWh`
    : null;
  const actualLine = hour.usage.actualDeviceKwh !== null
    ? `${labels.actualDeviceSeriesName} ${hour.usage.actualDeviceKwh.toFixed(1)} kWh`
    : null;
  const revisionLine = hour.changed && hour.revisionReason !== null
    ? (labels.revisionReasonTooltipLine[hour.revisionReason] ?? null)
    : null;
  return [
    `<strong>${encodeHtml(hour.time)}</strong>`,
    `Price ${encodeHtml(hour.price)} ${encodeHtml(payload.priceUnitLabel)}`,
    `${encodeHtml(labels.backgroundSeriesName)} ${hour.usage.backgroundKwh.toFixed(1)} kWh`,
    ...(originalLine ? [encodeHtml(originalLine)] : []),
    `${encodeHtml(labels.deviceSeriesName)} ${hour.usage.deviceKwh.toFixed(1)} kWh`,
    ...(actualLine ? [encodeHtml(actualLine)] : []),
    `Plan ${encodeHtml(planLabel)}`,
    `Progress ${formatProgressValue(hour.progress, labels.targetUnit)}`,
    ...(revisionLine ? [encodeHtml(revisionLine)] : []),
  ].join('<br>');
};

// Two-grid ECharts layout inside a 240 px container. Top: price, Bottom: load + progress overlay.
// The 44 px top reserves room for a two-line legend (`width: '100%'`) — with
// up to 5 long localized series names at 320–480 px the legend wraps, and a
// single-line `top: 28` left no room above the price grid.
const PRICE_GRID_TOP = 44;
const PRICE_GRID_HEIGHT = 56;
const LOAD_GRID_TOP = 126;
const LOAD_GRID_HEIGHT = 84;
const GRID_LEFT = 36;
const GRID_RIGHT = 56;

export const buildChartOption = (
  payload: DeadlinePlanPayload,
  palette: DeadlineChartPalette,
  typography: ChartTypography,
): EChartsOption => {
  const hourCount = payload.timeline.hours.length;
  const labels = payload.timeline.hours.map((hour) => hour.time);
  const showLabelEvery = hourCount > 10 ? 3 : 2;
  // Use the natural max of the (already scaled) display values; do not clamp
  // to a fixed floor like `1` — kr/kWh values are typically in the 0.5–2 range
  // and clamping would squash the bars against the bottom of the price grid.
  const priceValues = payload.timeline.hours.map((hour) => hour.priceValue);
  const rawPriceMax = priceValues.length ? Math.max(...priceValues) : 0;
  const priceMax = rawPriceMax > 0 ? rawPriceMax : 1;
  const priceMin = priceValues.length ? Math.min(...priceValues) : 0;
  const priceRange = priceMax - priceMin;
  const priceAxisMin = priceRange > 0.01 ? priceMin : 0;
  const stackedMax = Math.max(0.5, ...payload.timeline.hours.map((hour) => (
    Math.max(
      hour.usage.backgroundKwh + Math.max(hour.usage.originalDeviceKwh, hour.usage.deviceKwh),
      hour.usage.actualDeviceKwh ?? 0,
    )
  )));
  const originalSeriesName = payload.labels.originalDeviceSeriesName;
  const hasActualDeviceSeries = payload.timeline.hours.some((hour) => hour.usage.actualDeviceKwh !== null);
  // Suppress the original-series legend and overlay bars when the plan has never
  // been revised: every hour's originalDeviceKwh equals deviceKwh, so rendering
  // both series produces duplicate legend entries with no informational gain.
  // Matches the suppression logic in DeadlinePlanHistoryDetail.
  const hasOriginalSeries = payload.timeline.hours.some(
    (hour) => Math.abs(hour.usage.originalDeviceKwh - hour.usage.deviceKwh) > 0.001,
  );

  const axisBase = {
    type: 'category' as const,
    data: labels,
    boundaryGap: true,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: palette.grid } },
    axisLabel: {
      color: palette.muted,
      fontSize: typography.labelFontSize,
      interval: (index: number) => index === 0 || index === hourCount - 1 || index % showLabelEvery === 0,
      formatter: (value: string, index: number) => {
        if (index === 0) return `Now\n${value}`;
        if (index === hourCount - 1) return `${payload.timeline.deadlineLabel}\n${value}`;
        return value;
      },
    },
  };
  const valueAxisBase = {
    type: 'value' as const,
    splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: palette.text, fontSize: typography.labelFontSize },
  };
  const axisNameStyle = {
    color: palette.text,
    fontSize: typography.axisNameFontSize,
    fontWeight: typography.axisNameFontWeight,
    align: 'center' as const,
  };
  const showCeilingOnly = (max: number, label: string) => (value: number) => (
    Math.abs(value - max) < 0.001 ? label : ''
  );
  const nowMarkLine = {
    silent: true,
    symbol: 'none' as const,
    lineStyle: { color: palette.muted, type: 'dashed' as const, width: 1 },
    label: { show: false },
    data: [{ xAxis: 0 }],
  };

  return {
    animation: false,
    backgroundColor: 'transparent',
    color: [palette.background, palette.device, palette.actualDevice, palette.progress],
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    legend: {
      top: 0,
      left: 0,
      // Let the legend wrap onto a second row instead of truncating to
      // "Background usa…" / "Original Heatin…" / "Measured Heati…" when 4–5
      // long localized series names overflow the 320–480 px chart width.
      // `PRICE_GRID_TOP` (44) and the container `.deadline-horizon-chart`
      // height token reserve enough vertical room for a two-line legend.
      width: '100%',
      // Explicit `itemStyle` per entry: the original-plan series renders its
      // bars as `transparent` fill + colored border, which would otherwise
      // produce an invisible legend swatch. Pin each legend swatch to the
      // colour the user actually sees in the rendered series.
      data: [
        { name: payload.labels.backgroundSeriesName, itemStyle: { color: palette.background } },
        { name: payload.labels.deviceSeriesName, itemStyle: { color: palette.device } },
        ...(hasOriginalSeries
          ? [{
              name: originalSeriesName,
              itemStyle: {
                color: 'transparent',
                borderColor: palette.device,
                borderWidth: 2,
                borderType: 'dashed' as const,
              },
            }]
          : []),
        ...(hasActualDeviceSeries
          ? [{ name: payload.labels.actualDeviceSeriesName, itemStyle: { color: palette.actualDevice } }]
          : []),
        { name: 'Target progress', itemStyle: { color: palette.progress } },
      ],
      itemWidth: 12,
      itemHeight: 8,
      icon: 'roundRect',
      textStyle: { color: palette.muted, fontSize: typography.labelFontSize },
      inactiveColor: palette.grid,
    },
    grid: [
      { top: PRICE_GRID_TOP, left: GRID_LEFT, right: GRID_RIGHT, height: PRICE_GRID_HEIGHT },
      { top: LOAD_GRID_TOP, left: GRID_LEFT, right: GRID_RIGHT, height: LOAD_GRID_HEIGHT },
    ],
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: true,
      backgroundColor: palette.tooltipBackground,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.tooltipText },
      formatter: (params: unknown) => buildTooltip(payload, params),
    },
    xAxis: [
      { ...axisBase, gridIndex: 0, axisLabel: { show: false } },
      { ...axisBase, gridIndex: 1 },
    ],
    yAxis: [
      {
        ...valueAxisBase,
        gridIndex: 0,
        position: 'right',
        name: payload.priceUnitLabel,
        nameLocation: 'middle',
        nameGap: GRID_RIGHT - 12,
        nameRotate: 0,
        nameTextStyle: axisNameStyle,
        min: priceAxisMin,
        max: priceMax,
        // Force a single tick at min / max so the axis labels stay readable in
        // the narrow 56-px price grid — without this, kr/kWh values can fall
        // into ECharts' default 5-tick layout and overlap.
        interval: Math.max(0.01, priceMax - priceAxisMin),
        axisLabel: {
          ...valueAxisBase.axisLabel,
          // One-decimal precision matches the Budget chart's price axis
          // (`budgetRedesignChart.ts:400`) so users see the same number
          // format on both surfaces. Tooltip retains two-decimal precision
          // via `formatPrice` in `deadlinePlan.ts`.
          formatter: (value: number) => {
            if (Math.abs(value - priceMax) < 0.001) return priceMax.toFixed(1);
            if (priceAxisMin !== 0 && Math.abs(value - priceAxisMin) < 0.001) return priceMin.toFixed(1);
            return '';
          },
        },
      },
      {
        ...valueAxisBase,
        gridIndex: 1,
        position: 'right',
        name: 'kWh',
        nameLocation: 'middle',
        nameGap: GRID_RIGHT - 12,
        nameRotate: 0,
        nameTextStyle: axisNameStyle,
        min: 0,
        max: stackedMax,
        interval: stackedMax,
        axisLabel: {
          ...valueAxisBase.axisLabel,
          formatter: showCeilingOnly(stackedMax, stackedMax.toFixed(1)),
        },
      },
      {
        ...valueAxisBase,
        gridIndex: 1,
        position: 'left',
        name: payload.labels.targetUnit,
        nameLocation: 'middle',
        nameGap: GRID_LEFT - 12,
        nameRotate: 0,
        nameTextStyle: { ...axisNameStyle, color: palette.progress },
        min: payload.timeline.progressFloor,
        max: payload.timeline.progressCeilingValue,
        interval: Math.max(1, payload.timeline.progressCeilingValue - payload.timeline.progressFloor),
        splitLine: { show: false },
        axisLabel: {
          ...valueAxisBase.axisLabel,
          color: palette.progress,
          formatter: showCeilingOnly(payload.timeline.progressCeilingValue, payload.timeline.progressCeilingLabel),
        },
      },
    ],
    series: [
      {
        name: 'Price',
        type: 'bar',
        xAxisIndex: 0,
        yAxisIndex: 0,
        barMaxWidth: 18,
        barMinHeight: 3,
        markLine: nowMarkLine,
        data: payload.timeline.hours.map((hour) => ({
          value: hour.priceValue,
          itemStyle: {
            color: hour.tone === 'cheap'
              ? palette.priceCheap
              : hour.tone === 'expensive'
                ? palette.priceExpensive
                : palette.priceNormal,
            borderRadius: [5, 5, 2, 2],
          },
        })),
      },
      {
        name: payload.labels.backgroundSeriesName,
        type: 'bar',
        stack: 'load',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 18,
        markLine: nowMarkLine,
        data: payload.timeline.hours.map((hour) => hour.usage.backgroundKwh),
        itemStyle: { color: palette.background, borderRadius: [0, 0, 0, 0] },
      },
      {
        name: payload.labels.deviceSeriesName,
        type: 'bar',
        stack: 'load',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 18,
        data: payload.timeline.hours.map((hour) => ({
          value: hour.usage.deviceKwh,
          itemStyle: {
            color: palette.device,
            opacity: hour.planned ? 1 : 0.45,
            borderColor: hour.changed ? palette.tooltipText : palette.device,
            borderWidth: hour.changed ? 1 : 0,
            borderRadius: [3, 3, 0, 0],
          },
        })),
      },
      ...(hasOriginalSeries ? [
        {
          name: payload.labels.backgroundSeriesName,
          type: 'bar' as const,
          stack: 'original-load',
          xAxisIndex: 1,
          yAxisIndex: 1,
          barMaxWidth: 18,
          barGap: '-100%',
          silent: true,
          tooltip: { show: false },
          itemStyle: { color: 'transparent', borderColor: 'transparent' },
          emphasis: { disabled: true },
          data: payload.timeline.hours.map((hour) => hour.usage.backgroundKwh),
        },
        {
          name: originalSeriesName,
          type: 'bar' as const,
          stack: 'original-load',
          xAxisIndex: 1,
          yAxisIndex: 1,
          barMaxWidth: 18,
          barGap: '-100%',
          itemStyle: { color: 'transparent', borderColor: palette.device, borderWidth: 2 },
          data: payload.timeline.hours.map((hour) => ({
            value: hour.usage.originalDeviceKwh,
            itemStyle: {
              color: 'transparent',
              borderColor: hour.usage.originalDeviceKwh > 0 ? palette.device : 'transparent',
              borderWidth: hour.usage.originalDeviceKwh > 0 ? 2 : 0,
              borderType: hour.changed ? 'dashed' as const : 'solid' as const,
              borderRadius: [3, 3, 0, 0],
            },
          })),
        },
      ] : []),
      ...(hasActualDeviceSeries ? [{
        name: payload.labels.actualDeviceSeriesName,
        type: 'line' as const,
        xAxisIndex: 1,
        yAxisIndex: 1,
        symbol: 'circle',
        symbolSize: 7,
        connectNulls: false,
        lineStyle: { color: palette.actualDevice, width: 2, type: 'dotted' as const },
        itemStyle: { color: palette.actualDevice },
        data: payload.timeline.hours.map((hour) => hour.usage.actualDeviceKwh),
      }] : []),
      {
        name: 'Target progress',
        type: 'line',
        step: 'end',
        xAxisIndex: 1,
        yAxisIndex: 2,
        symbol: 'none',
        lineStyle: { color: palette.progress, width: 2 },
        areaStyle: { color: palette.progress, opacity: 0.12 },
        data: payload.timeline.hours.map((hour) => hour.progress),
      },
    ] satisfies SeriesOption[],
  };
};

const HorizonChart = ({ payload }: { payload: DeadlinePlanPayload }) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const container = chartRef.current;
    if (!container) return undefined;
    const chart = initEcharts(container, undefined, {
      renderer: 'svg',
      ...resolveChartSize(container),
    });
    chartInstanceRef.current = chart;
    chart.setOption(
      buildChartOption(payload, resolvePalette(container), resolveTypography(container)),
      { notMerge: true },
    );

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => chart.resize(resolveChartSize(container)))
      : null;
    resizeObserver?.observe(container);
    // Cold-mount path: the chart may be initialized while its panel is still
    // `display:none`, so `clientWidth` was the 480 px fallback. Resize once on
    // the next frame so the SVG settles to the real visible width before the
    // user sees it, and re-resize whenever the chart's tab is shown again.
    const detachTabShown = attachTabShownResize({ container, chart, resolveSize: resolveChartSize });

    return () => {
      resizeObserver?.disconnect();
      detachTabShown();
      chart.dispose();
      if (chartInstanceRef.current === chart) chartInstanceRef.current = null;
    };
  }, [payload]);

  return <div ref={chartRef} class="deadline-horizon-chart" role="img" aria-label={payload.timeline.ariaLabel} />;
};

const HorizonCard = ({ payload }: { payload: DeadlinePlanPayload }) => (
  <section class="pels-surface-card budget-redesign-card deadline-horizon-card" aria-labelledby="deadline-horizon-title">
    <div class="budget-card-header">
      <h2 class="plan-card__title" id="deadline-horizon-title">Price horizon</h2>
    </div>
    <HorizonChart payload={payload} />
  </section>
);

const PlanInputsCard = ({ payload }: { payload: DeadlinePlanPayload }) => {
  const { perUnitRateLabel, perUnitRateNote, maxPowerLabel } = payload.planInputs;
  if (perUnitRateLabel === null && maxPowerLabel === null) return null;
  return (
    <section class="pels-surface-card budget-redesign-card" aria-labelledby="deadline-plan-inputs-title">
      <div class="budget-card-header">
        <h2 class="plan-card__title" id="deadline-plan-inputs-title">{payload.labels.planInputsCardTitle}</h2>
      </div>
      <dl class="plan-inputs__list">
        {perUnitRateLabel !== null && (
          <div class="plan-inputs__row">
            <dt class="plan-inputs__row-label">{payload.labels.planInputsRateRowLabel}</dt>
            <dd class="plan-inputs__row-value">
              {perUnitRateLabel}
              {perUnitRateNote !== null && (
                <div class="plan-inputs__row-note">{perUnitRateNote}</div>
              )}
            </dd>
          </div>
        )}
        {maxPowerLabel !== null && (
          <div class="plan-inputs__row">
            <dt class="plan-inputs__row-label">{payload.labels.planInputsMaxPowerRowLabel}</dt>
            <dd class="plan-inputs__row-value">{maxPowerLabel}</dd>
          </div>
        )}
      </dl>
    </section>
  );
};


const PendingHero = ({ pending }: { pending: DeadlinePlanPendingPayload }) => (
  <section class="plan-hero pels-hero" data-tone="info" aria-labelledby="deadline-plan-pending-title">
    <div class="plan-hero__chips">
      {pending.hero.chips.map((chip) => (
        <span key={chip.text} class={chipClass(chip.tone)}>{chip.text}</span>
      ))}
    </div>
    <div class="plan-hero__section">
      <span class="plan-hero__section-label eyebrow" id="deadline-plan-pending-title">{pending.hero.sectionLabel}</span>
      <div class="plan-hero__headline">{pending.hero.headline}</div>
      <div class="plan-hero__subline">{pending.hero.subline}</div>
      <div class="plan-hero__subline plan-hero__subline--muted">{pending.hero.metaLine}</div>
    </div>
  </section>
);

const DeadlinePlanRoot = ({ loadState }: { loadState: DeadlinePlanLoadState }) => {
  if (loadState.status === 'history-detail') {
    return <DeadlinePlanHistoryDetail entry={loadState.entry} timeZone={loadState.timeZone} />;
  }
  if (loadState.status === 'history-missing') {
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">Plan not found</h1>
        <p class="pels-card-supporting">This past plan is no longer recorded. Older entries roll off as new ones are saved. Return to Smart tasks to see what is still available.</p>
      </section>
    );
  }
  if (loadState.status === 'loading') {
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">Loading smart task plan</h1>
        <p class="pels-card-supporting">Preparing the device plan.</p>
      </section>
    );
  }
  if (loadState.status === 'error') {
    const onRetry = loadState.onRetry;
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">Smart task plan unavailable</h1>
        <p class="pels-card-supporting">{loadState.message}</p>
        {onRetry && (
          <MdTextButton class="plan-card__retry" onClick={onRetry}>
            Try again
          </MdTextButton>
        )}
      </section>
    );
  }
  if (loadState.status === 'pending') {
    return <PendingHero pending={loadState.pending} />;
  }
  if (loadState.status === 'unavailable') {
    const copy = deadlineLabels(loadState.objectiveKind).unavailableByReason[loadState.reason];
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">{copy.headline}</h1>
        <p class="pels-card-supporting">{copy.body}</p>
      </section>
    );
  }
  if (loadState.status === 'completed') {
    const copy = deadlineLabels(loadState.objectiveKind).completedHero;
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">{copy.headline}</h1>
        <p class="pels-card-supporting">{copy.body} Past plans are listed under Smart tasks.</p>
      </section>
    );
  }
  return (
    <>
      <DeadlineHero payload={loadState.payload} />
      <HorizonCard payload={loadState.payload} />
      <PlanInputsCard payload={loadState.payload} />
    </>
  );
};

export const renderDeadlinePlan = (
  surface: HTMLElement,
  loadState: DeadlinePlanLoadState,
): void => {
  render(<DeadlinePlanRoot loadState={loadState} />, surface);
};
