import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DeferredObjectiveSettingsKind } from '../../../../contracts/src/deferredObjectiveSettings.ts';
import {
  deadlineLabels,
  type DeadlineLabels,
  type DeadlinePlanUnavailableReason,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import { encodeHtml, initEcharts, type EChartsOption, type EChartsType, type SeriesOption } from '../echartsRegistry.ts';
import type { DeadlinePlanHistoryView } from '../deadlinePlanHistoryFetch.ts';
import { DeadlinePlanHistory } from './DeadlinePlanHistory.tsx';

type DeadlinePlanChipTone = 'info' | 'muted' | 'ok' | 'warn';
type DeadlinePlanHourTone = 'cheap' | 'expensive' | 'normal';

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
  usage: {
    backgroundKwh: number;
    deviceKwh: number;
  };
  progress: number;
};

export type DeadlinePlanPayload = {
  kind: DeferredObjectiveSettingsKind;
  labels: DeadlineLabels;
  hero: {
    chips: DeadlinePlanChip[];
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
  | { status: 'error'; message: string; history?: DeadlinePlanHistoryView }
  | { status: 'loading'; history?: DeadlinePlanHistoryView }
  | { status: 'pending'; pending: DeadlinePlanPendingPayload; history?: DeadlinePlanHistoryView }
  | {
    status: 'unavailable';
    objectiveKind: DeferredObjectiveSettingsKind;
    reason: DeadlinePlanUnavailableReason;
    history?: DeadlinePlanHistoryView;
  }
  | { status: 'ready'; payload: DeadlinePlanPayload; history?: DeadlinePlanHistoryView };

const chipClass = (tone: DeadlinePlanChipTone): string => `plan-chip plan-chip--${tone}`;

const DeadlineHero = ({ payload }: { payload: DeadlinePlanPayload }) => (
  <section class="plan-hero" data-tone="ok" aria-labelledby="deadline-plan-title">
    <div class="plan-hero__chips">
      {payload.hero.chips.map((chip) => (
        <span key={chip.text} class={chipClass(chip.tone)}>{chip.text}</span>
      ))}
    </div>
    <div class="plan-hero__section">
      <span class="plan-hero__section-label" id="deadline-plan-title">{payload.hero.sectionLabel}</span>
      <div class="plan-hero__headline">{payload.hero.headline}</div>
      <div class="plan-hero__subline">{payload.hero.subline}</div>
      <div class="plan-hero__subline plan-hero__subline--muted">{payload.hero.metaLine}</div>
    </div>
  </section>
);

type DeadlineChartPalette = {
  priceCheap: string;
  priceNormal: string;
  priceExpensive: string;
  background: string;
  device: string;
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
  progress: cssVar(element, '--color-base-info-default'),
  grid: cssVar(element, '--pels-surface-outline'),
  text: cssVar(element, '--text'),
  muted: cssVar(element, '--pels-text-supporting-color'),
  tooltipBackground: cssVar(element, '--color-overlay-toast'),
  tooltipText: cssVar(element, '--color-semantic-text-primary'),
  tooltipBorder: cssVar(element, '--color-border-medium'),
});

type ChartTypography = {
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
    height: element.clientHeight > 0 ? element.clientHeight : 220,
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
  return [
    `<strong>${encodeHtml(hour.time)}</strong>`,
    `Price ${encodeHtml(hour.price)}`,
    `${encodeHtml(labels.backgroundSeriesName)} ${hour.usage.backgroundKwh.toFixed(1)} kWh`,
    `${encodeHtml(labels.deviceSeriesName)} ${hour.usage.deviceKwh.toFixed(1)} kWh`,
    `Plan ${encodeHtml(planLabel)}`,
    `Progress ${formatProgressValue(hour.progress, labels.targetUnit)}`,
  ].join('<br>');
};

// Two-grid ECharts layout inside a 220 px container. Top: price, Bottom: load + progress overlay.
const PRICE_GRID_TOP = 28;
const PRICE_GRID_HEIGHT = 56;
const LOAD_GRID_TOP = 110;
const LOAD_GRID_HEIGHT = 84;
const GRID_LEFT = 36;
const GRID_RIGHT = 56;

const buildChartOption = (
  payload: DeadlinePlanPayload,
  palette: DeadlineChartPalette,
  typography: ChartTypography,
): EChartsOption => {
  const hourCount = payload.timeline.hours.length;
  const labels = payload.timeline.hours.map((hour) => hour.time);
  const showLabelEvery = hourCount > 10 ? 3 : 2;
  const priceMax = Math.max(1, ...payload.timeline.hours.map((hour) => hour.priceValue));
  const priceMin = Math.min(...payload.timeline.hours.map((hour) => hour.priceValue));
  const priceRange = priceMax - priceMin;
  const priceAxisMin = priceRange > 0.01 ? priceMin : 0;
  const stackedMax = Math.max(0.5, ...payload.timeline.hours.map((hour) => (
    hour.usage.backgroundKwh + hour.usage.deviceKwh
  )));

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
    color: [palette.background, palette.device, palette.progress],
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    legend: {
      top: 0,
      left: 0,
      data: [payload.labels.backgroundSeriesName, payload.labels.deviceSeriesName, 'Target progress'],
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
        name: 'Price',
        nameLocation: 'middle',
        nameGap: GRID_RIGHT - 12,
        nameRotate: 0,
        nameTextStyle: axisNameStyle,
        min: priceAxisMin,
        max: priceMax,
        interval: Math.max(1, priceMax - priceAxisMin),
        axisLabel: {
          ...valueAxisBase.axisLabel,
          formatter: (value: number) => {
            if (Math.abs(value - priceMax) < 0.001) return priceMax.toFixed(2);
            if (priceAxisMin !== 0 && Math.abs(value - priceAxisMin) < 0.001) return priceMin.toFixed(2);
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
            borderRadius: [3, 3, 0, 0],
          },
        })),
      },
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

    return () => {
      resizeObserver?.disconnect();
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
  const { perUnitRateLabel, maxPowerLabel } = payload.planInputs;
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
            <dd class="plan-inputs__row-value">{perUnitRateLabel}</dd>
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

type DeadlinePlanTab = 'current' | 'history';

const PlanTabStrip = ({ active, onChange }: {
  active: DeadlinePlanTab;
  onChange: (next: DeadlinePlanTab) => void;
}) => (
  // Rendered as a segmented toggle (group of buttons), not the full ARIA tabs pattern.
  // The ARIA tabs pattern requires aria-controls / role=tabpanel linkage and roving
  // tabIndex / arrow-key navigation; for two large native buttons on a 480-px-wide mobile
  // surface those affordances don't add value over standard button semantics.
  <div class="plan-tabs" role="group" aria-label="Plan view tabs">
    <button
      type="button"
      aria-pressed={active === 'current'}
      class={`plan-tabs__tab${active === 'current' ? ' plan-tabs__tab--active' : ''}`}
      onClick={() => onChange('current')}
    >
      Current plan
    </button>
    <button
      type="button"
      aria-pressed={active === 'history'}
      class={`plan-tabs__tab${active === 'history' ? ' plan-tabs__tab--active' : ''}`}
      onClick={() => onChange('history')}
    >
      History
    </button>
  </div>
);

const PendingHero = ({ pending }: { pending: DeadlinePlanPendingPayload }) => (
  <section class="plan-hero" data-tone="info" aria-labelledby="deadline-plan-pending-title">
    <div class="plan-hero__chips">
      {pending.hero.chips.map((chip) => (
        <span key={chip.text} class={chipClass(chip.tone)}>{chip.text}</span>
      ))}
    </div>
    <div class="plan-hero__section">
      <span class="plan-hero__section-label" id="deadline-plan-pending-title">{pending.hero.sectionLabel}</span>
      <div class="plan-hero__headline">{pending.hero.headline}</div>
      <div class="plan-hero__subline">{pending.hero.subline}</div>
      <div class="plan-hero__subline plan-hero__subline--muted">{pending.hero.metaLine}</div>
    </div>
  </section>
);

const CurrentPlanContent = ({ loadState }: { loadState: DeadlinePlanLoadState }) => {
  if (loadState.status === 'loading') {
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">Loading deadline plan</h1>
        <p class="pels-card-supporting">Preparing the device plan.</p>
      </section>
    );
  }
  if (loadState.status === 'error') {
    return (
      <section class="pels-surface-card budget-redesign-card">
        <h1 class="plan-card__title">Deadline plan unavailable</h1>
        <p class="pels-card-supporting">{loadState.message}</p>
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
  return (
    <>
      <DeadlineHero payload={loadState.payload} />
      <HorizonCard payload={loadState.payload} />
      <PlanInputsCard payload={loadState.payload} />
    </>
  );
};

const DeadlinePlanRoot = ({ loadState }: { loadState: DeadlinePlanLoadState }) => {
  const [activeTab, setActiveTab] = useState<DeadlinePlanTab>('current');
  const history = loadState.history;
  return (
    <>
      <PlanTabStrip active={activeTab} onChange={setActiveTab} />
      {activeTab === 'current' ? (
        <CurrentPlanContent loadState={loadState} />
      ) : (
        <DeadlinePlanHistory
          entries={history?.entries ?? []}
          timeZone={history?.timeZone ?? 'UTC'}
        />
      )}
    </>
  );
};

export const renderDeadlinePlan = (
  surface: HTMLElement,
  loadState: DeadlinePlanLoadState,
): void => {
  render(<DeadlinePlanRoot loadState={loadState} />, surface);
};
