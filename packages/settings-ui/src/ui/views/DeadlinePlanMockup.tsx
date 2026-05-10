import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
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
  plan?: 'Charge' | 'Fallback';
  usage?: {
    otherKwh: number;
    chargerKwh: number;
    hardCapKwh: number;
  };
  progress?: number;
};

export type DeadlinePlanMockupPayload = {
  hero: {
    chips: DeadlinePlanChip[];
    sectionLabel: string;
    headline: string;
    subline: string;
    decision: string;
  };
  timeline: {
    subtitle: string;
    ariaLabel: string;
    priceCeiling: string;
    plannedLoadCeiling: string;
    progressCeiling: string;
    progressFloor: number;
    progressCeilingValue: number;
    progressUnit: '%' | '°C';
    hours: DeadlinePlanHour[];
    explainer: string;
  };
};

export type { DeadlinePlanHistoryView } from '../deadlinePlanHistoryFetch.ts';

export type DeadlinePlanMockupLoadState =
  | { status: 'error'; message: string; history?: DeadlinePlanHistoryView }
  | { status: 'loading'; history?: DeadlinePlanHistoryView }
  | { status: 'ready'; payload: DeadlinePlanMockupPayload; history?: DeadlinePlanHistoryView };

const chipClass = (tone: DeadlinePlanChipTone): string => `plan-chip plan-chip--${tone}`;

const DeadlineHero = ({ payload }: { payload: DeadlinePlanMockupPayload }) => (
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
      <p class="plan-hero__decision" data-positive>{payload.hero.decision}</p>
    </div>
  </section>
);

type DeadlineChartPalette = {
  priceCheap: string;
  priceNormal: string;
  priceExpensive: string;
  otherLoad: string;
  charger: string;
  charging: string;
  fallback: string;
  progress: string;
  grid: string;
  text: string;
  muted: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
};

const resolveCssColor = (element: HTMLElement, variable: string, fallback: string): string => {
  const raw = getComputedStyle(element).getPropertyValue(variable).trim();
  return raw || fallback;
};

const resolvePalette = (element: HTMLElement): DeadlineChartPalette => ({
  priceCheap: resolveCssColor(element, '--color-base-accent-default', '#10b981'),
  priceNormal: resolveCssColor(element, '--color-surface-5', '#6b7785'),
  priceExpensive: resolveCssColor(element, '--color-base-warning-default', '#f59e0b'),
  otherLoad: resolveCssColor(element, '--pels-text-supporting-color', '#8c98a4'),
  charger: resolveCssColor(element, '--color-base-accent-default', '#10b981'),
  charging: resolveCssColor(element, '--color-base-accent-default', '#10b981'),
  fallback: resolveCssColor(element, '--color-base-info-default', '#38bdf8'),
  progress: resolveCssColor(element, '--color-base-info-default', '#38bdf8'),
  grid: resolveCssColor(element, '--pels-surface-outline', 'rgba(255,255,255,0.18)'),
  text: resolveCssColor(element, '--text', '#e6ecf5'),
  muted: resolveCssColor(element, '--pels-text-supporting-color', '#9aa8b6'),
  tooltipBackground: resolveCssColor(element, '--color-overlay-toast', 'rgba(12, 17, 27, 0.92)'),
  tooltipText: resolveCssColor(element, '--color-semantic-text-primary', '#e6ecf5'),
  tooltipBorder: resolveCssColor(element, '--color-border-medium', 'rgba(255, 255, 255, 0.15)'),
});

const resolveChartSize = (element: HTMLElement): { height: number; width: number } => {
  const width = element.clientWidth > 0 ? element.clientWidth : (element.parentElement?.clientWidth ?? 390);
  const viewportWidth = document.documentElement?.clientWidth ?? 0;
  return {
    width: width > 0 ? width : Math.min(480, viewportWidth || 390),
    height: element.clientHeight > 0 ? element.clientHeight : 282,
  };
};

const buildTooltip = (payload: DeadlinePlanMockupPayload, rawParams: unknown): string => {
  const params = Array.isArray(rawParams) ? rawParams : [rawParams];
  const first = params.find((item): item is { dataIndex: number } => (
    Boolean(item) && typeof item === 'object' && Number.isInteger((item as { dataIndex?: unknown }).dataIndex)
  ));
  const hour = first ? payload.timeline.hours[first.dataIndex] : null;
  if (!hour) return '';
  const usage = hour.usage ?? { otherKwh: 0, chargerKwh: 0, hardCapKwh: 0 };
  return [
    `<strong>${encodeHtml(hour.time)}</strong>`,
    `Price ${encodeHtml(hour.price)}`,
    `Other load ${usage.otherKwh.toFixed(1)} kWh`,
    `This device ${usage.chargerKwh.toFixed(1)} kWh`,
    `Plan ${encodeHtml(hour.plan ?? 'Idle')}`,
    `Progress ${formatProgressValue(hour.progress ?? 0, payload.timeline.progressUnit)}`,
  ].join('<br>');
};

const formatProgressValue = (value: number, unit: DeadlinePlanMockupPayload['timeline']['progressUnit']): string => (
  unit === '°C' ? `${value.toFixed(1)} °C` : `${Math.round(value)}%`
);

const buildChartOption = (
  payload: DeadlinePlanMockupPayload,
  palette: DeadlineChartPalette,
): EChartsOption => {
  const hourCount = payload.timeline.hours.length;
  const labels = payload.timeline.hours.map((hour) => hour.time);
  const showLabelEvery = hourCount > 10 ? 3 : 2;
  const hardCapKwh = Math.max(1, ...payload.timeline.hours.map((hour) => hour.usage?.hardCapKwh ?? 0));
  const priceMax = Math.max(1, ...payload.timeline.hours.map((hour) => hour.priceValue));
  const priceMin = Math.min(...payload.timeline.hours.map((hour) => hour.priceValue));
  const priceRange = priceMax - priceMin;
  const priceAxisMin = priceRange > 0.01 ? priceMin : 0;
  const hasFallback = payload.timeline.hours.some((hour) => hour.plan === 'Fallback');
  const legendData = [
    'Other load',
    'This device',
    'Charging',
    ...(hasFallback ? ['Fallback'] : []),
  ];
  const showCeilingLabel = (ceiling: number, label: string) => (value: number) => (
    Math.abs(value - ceiling) < 0.001 ? label : ''
  );
  const axisBase = {
    type: 'category' as const,
    data: labels,
    boundaryGap: true,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: palette.grid } },
    axisLabel: {
      color: palette.muted,
      fontSize: 10,
      interval: (index: number) => index === 0 || index === hourCount - 1 || index % showLabelEvery === 0,
      formatter: (value: string, index: number) => (index === 0 ? `Now\n${value}` : value),
    },
  };
  const valueAxisBase = {
    type: 'value' as const,
    splitLine: { lineStyle: { color: palette.grid, opacity: 0.55 } },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: palette.text, fontSize: 10 },
  };

  return {
    animation: false,
    backgroundColor: 'transparent',
    color: [palette.otherLoad, palette.charger, palette.charging, palette.progress],
    textStyle: { color: palette.text, fontFamily: 'inherit' },
    legend: {
      top: 0,
      left: 0,
      data: legendData,
      itemWidth: 12,
      itemHeight: 8,
      icon: 'roundRect',
      textStyle: { color: palette.muted, fontSize: 11 },
      inactiveColor: palette.grid,
    },
    grid: [
      { top: 32, left: 8, right: 82, height: 48 },
      { top: 96, left: 8, right: 82, height: 54 },
      { top: 169, left: 8, right: 82, height: 26 },
      { top: 212, left: 8, right: 82, height: 50 },
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
      { ...axisBase, gridIndex: 1, axisLabel: { show: false } },
      { ...axisBase, gridIndex: 2, axisLabel: { show: false } },
      { ...axisBase, gridIndex: 3 },
    ],
    yAxis: [
      {
        ...valueAxisBase,
        gridIndex: 0,
        position: 'right',
        name: 'Price',
        nameLocation: 'middle',
        nameGap: 52,
        nameRotate: 0,
        nameTextStyle: { color: palette.text, fontSize: 11, fontWeight: 700, align: 'center', lineHeight: 14 },
        min: priceAxisMin,
        max: priceMax,
        interval: Math.max(1, priceMax - priceAxisMin),
        axisLabel: {
          ...valueAxisBase.axisLabel,
          formatter: (value: number) => {
            if (Math.abs(value - priceMax) < 0.001) return payload.timeline.priceCeiling;
            if (priceAxisMin !== 0 && Math.abs(value - priceAxisMin) < 0.001) return priceMin.toFixed(2);
            return '';
          },
        },
      },
      {
        ...valueAxisBase,
        gridIndex: 1,
        position: 'right',
        name: 'Planned\nload',
        nameLocation: 'middle',
        nameGap: 52,
        nameRotate: 0,
        nameTextStyle: { color: palette.text, fontSize: 11, fontWeight: 700, align: 'center', lineHeight: 14 },
        min: 0,
        max: hardCapKwh,
        interval: hardCapKwh,
        axisLabel: {
          ...valueAxisBase.axisLabel,
          formatter: showCeilingLabel(hardCapKwh, payload.timeline.plannedLoadCeiling),
        },
      },
      {
        ...valueAxisBase,
        gridIndex: 2,
        position: 'right',
        name: 'Charging\nplan',
        nameLocation: 'middle',
        nameGap: 52,
        nameRotate: 0,
        nameTextStyle: { color: palette.text, fontSize: 11, fontWeight: 700, align: 'center', lineHeight: 14 },
        min: 0,
        max: 1,
        splitLine: { show: false },
        axisLabel: { show: false },
      },
      {
        ...valueAxisBase,
        gridIndex: 3,
        position: 'right',
        name: 'Target\nprogress',
        nameLocation: 'middle',
        nameGap: 52,
        nameRotate: 0,
        nameTextStyle: { color: palette.text, fontSize: 11, fontWeight: 700, align: 'center', lineHeight: 14 },
        min: payload.timeline.progressFloor,
        max: payload.timeline.progressCeilingValue,
        interval: Math.max(1, payload.timeline.progressCeilingValue - payload.timeline.progressFloor),
        axisLabel: {
          ...valueAxisBase.axisLabel,
          formatter: showCeilingLabel(payload.timeline.progressCeilingValue, payload.timeline.progressCeiling),
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
        name: 'Other load',
        type: 'bar',
        stack: 'load',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 18,
        data: payload.timeline.hours.map((hour) => hour.usage?.otherKwh ?? 0),
        itemStyle: { color: palette.otherLoad, borderRadius: [0, 0, 0, 0] },
      },
      {
        name: 'This device',
        type: 'bar',
        stack: 'load',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 18,
        data: payload.timeline.hours.map((hour) => hour.usage?.chargerKwh ?? 0),
        itemStyle: { color: palette.charger, borderRadius: [0, 0, 0, 0] },
      },
      {
        name: 'Charging',
        type: 'bar',
        xAxisIndex: 2,
        yAxisIndex: 2,
        barMaxWidth: 20,
        data: payload.timeline.hours.map((hour) => (hour.plan === 'Charge' ? 1 : 0)),
        itemStyle: { color: palette.charging, borderRadius: [5, 5, 5, 5] },
      },
      ...(hasFallback ? [{
        name: 'Fallback',
        type: 'bar',
        xAxisIndex: 2,
        yAxisIndex: 2,
        barMaxWidth: 20,
        data: payload.timeline.hours.map((hour) => (hour.plan === 'Fallback' ? 1 : 0)),
        itemStyle: {
          color: 'transparent',
          borderColor: palette.fallback,
          borderWidth: 1.5,
          borderType: 'dashed',
          borderRadius: [5, 5, 5, 5],
        },
      }] satisfies SeriesOption[] : []),
      {
        name: 'Target progress',
        type: 'line',
        step: 'end',
        xAxisIndex: 3,
        yAxisIndex: 3,
        symbol: 'none',
        lineStyle: { color: palette.progress, width: 2 },
        data: payload.timeline.hours.map((hour) => hour.progress ?? 0),
      },
    ] satisfies SeriesOption[],
  };
};

const HorizonChart = ({ payload }: { payload: DeadlinePlanMockupPayload }) => {
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
    chart.setOption(buildChartOption(payload, resolvePalette(container)), { notMerge: true });

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

const HorizonCard = ({ payload }: { payload: DeadlinePlanMockupPayload }) => (
  <section class="pels-surface-card budget-redesign-card deadline-horizon-card" aria-labelledby="deadline-horizon-title">
    <div class="budget-card-header">
      <div>
        <h2 class="plan-card__title" id="deadline-horizon-title">Known-price horizon</h2>
        <p class="pels-card-supporting">{payload.timeline.subtitle}</p>
      </div>
    </div>

    <HorizonChart payload={payload} />

    <p class="pels-card-supporting budget-chart-caveat">{payload.timeline.explainer}</p>
  </section>
);

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

const CurrentPlanContent = ({ loadState }: { loadState: DeadlinePlanMockupLoadState }) => {
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
  return (
    <>
      <DeadlineHero payload={loadState.payload} />
      <HorizonCard payload={loadState.payload} />
    </>
  );
};

const DeadlinePlanMockupRoot = ({ loadState }: { loadState: DeadlinePlanMockupLoadState }) => {
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

export const renderDeadlinePlanMockup = (
  surface: HTMLElement,
  loadState: DeadlinePlanMockupLoadState,
): void => {
  render(<DeadlinePlanMockupRoot loadState={loadState} />, surface);
};
