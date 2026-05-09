import { render } from 'preact';
import { useRef, useLayoutEffect } from 'preact/hooks';
import { MdElevation } from './materialWebJSX.tsx';
import {
  renderBudgetRedesignChart,
  clearBudgetRedesignChart,
  type BudgetRedesignChartMode,
  type BudgetRedesignDayView,
} from '../budgetRedesignChart.ts';
import type { DailyBudgetDayPayload } from '../../../../contracts/src/dailyBudgetTypes.ts';
import type { CostDisplay } from '../dailyBudgetCost.ts';
import { formatKWh } from '../dailyBudgetFormat.ts';

export type BudgetLocalView = 'plan' | 'adjust';
export type BudgetStatus = 'noPlan' | 'within' | 'tight' | 'over';

export type BudgetHeroData = {
  planTitle: string;
  planDay: string;
  status: BudgetStatus;
  priceChip: 'price-shaped' | 'price-unavailable' | null;
  primary: string;
  primaryTone: 'critical' | 'warning' | null;
  secondary: string | null;
  meta: string | null;
  cost: string | null;
  nextAction: string;
  heroTone: 'ok' | 'warn' | 'alert';
};

export type BudgetChartData = {
  payload: DailyBudgetDayPayload;
  view: BudgetRedesignDayView;
  mode: BudgetRedesignChartMode;
  showPrice: boolean;
  showProjection: boolean;
  costDisplay: CostDisplay;
  chartTitle: string;
  chartSubtitle: string;
  caveat: string | null;
} | null;

export type BudgetAdjustData = {
  enabled: boolean;
  dailyBudgetKWh: number;
  priceShaping: boolean;
  controlledWeight: number;
  priceFlexShare: number;
  hardCapKw: number;
  safetyMarginKw: number;
};

export type BudgetOverviewProps = {
  localView: BudgetLocalView;
  view: BudgetRedesignDayView;
  hero: BudgetHeroData;
  chart: BudgetChartData;
  adjust: BudgetAdjustData;
  onLocalViewChange: (v: BudgetLocalView) => void;
  onDayChange: (v: BudgetRedesignDayView) => void;
  onChartModeChange: (v: BudgetRedesignChartMode) => void;
};

// ─── Toggle Group ─────────────────────────────────────────────────────────────

type ToggleOpt<T extends string> = { value: T; label: string };

const ToggleGroup = <T extends string>({
  options,
  value,
  ariaLabel,
  onChange,
}: {
  options: ToggleOpt<T>[];
  value: T;
  ariaLabel: string;
  onChange: (v: T) => void;
}) => (
  <div class="day-view-toggle" role="group" aria-label={ariaLabel}>
    {options.map((opt) => (
      <button
        key={opt.value}
        type="button"
        class={`day-view-toggle__button${value === opt.value ? ' is-active' : ''}`}
        aria-pressed={value === opt.value}
        onClick={() => onChange(opt.value)}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

// ─── Budget Hero ──────────────────────────────────────────────────────────────

const StatusChip = ({ status }: { status: BudgetStatus }) => {
  if (status === 'within') return null;
  if (status === 'noPlan') return <span class="plan-chip plan-chip--muted">No plan</span>;
  if (status === 'tight') return <span class="plan-chip plan-chip--warn">Tight</span>;
  return <span class="plan-chip plan-chip--alert">Over budget</span>;
};

const BudgetHero = ({ hero }: { hero: BudgetHeroData }) => (
  <section class="plan-hero" data-tone={hero.heroTone}>
    <div class="plan-hero__chips">
      <StatusChip status={hero.status} />
      <span class="plan-hero__meta-row">
        <span class="plan-hero__meta">{hero.planDay}</span>
        {hero.priceChip === 'price-shaped' && (
          <span class="plan-chip plan-chip--info">Price-shaped</span>
        )}
        {hero.priceChip === 'price-unavailable' && (
          <span class="plan-chip plan-chip--warn">Price unavailable</span>
        )}
      </span>
    </div>
    <div id="budget-plan-summary" class="plan-hero__section">
      <span id="budget-redesign-plan-title" class="plan-hero__section-label">{hero.planTitle}</span>
      <div
        class="plan-hero__headline"
        {...(hero.primaryTone ? { 'data-tone': hero.primaryTone } : {})}
      >
        {hero.primary}
      </div>
      {hero.secondary !== null && (
        <div class="plan-hero__subline">{hero.secondary}</div>
      )}
      {hero.meta !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{hero.meta}</div>
      )}
      {hero.cost !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{hero.cost}</div>
      )}
      <p class="plan-hero__decision">{hero.nextAction}</p>
    </div>
  </section>
);

// ─── Budget Chart ─────────────────────────────────────────────────────────────

type LegendItem = { label: string; cls: string };

const ChartLegend = ({
  view,
  showProjection,
  showPrice,
}: {
  view: BudgetRedesignDayView;
  showProjection: boolean;
  showPrice: boolean;
}) => {
  const items: LegendItem[] = [
    ...(view !== 'tomorrow' ? [{ label: 'Actual', cls: 'budget-chart-legend__swatch--actual' }] : []),
    { label: 'Plan', cls: '' },
    ...(showProjection ? [{ label: 'Projection', cls: 'budget-chart-legend__swatch--forecast' }] : []),
    ...(showPrice ? [{ label: 'Price', cls: 'budget-chart-legend__swatch--price' }] : []),
  ];
  if (items.length <= 1) return null;
  return (
    <div class="budget-chart-legend">
      {items.map((item) => (
        <span key={item.label} class="budget-chart-legend__item">
          <span class={['budget-chart-legend__swatch', item.cls].filter(Boolean).join(' ')} />
          <span>{item.label}</span>
        </span>
      ))}
    </div>
  );
};

const EChartsCanvas = ({ chart }: { chart: NonNullable<BudgetChartData> }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    renderBudgetRedesignChart({
      container,
      payload: chart.payload,
      mode: chart.mode,
      view: chart.view,
      priceReliable: chart.showPrice,
      costDisplay: chart.costDisplay,
    });
  });

  useLayoutEffect(() => () => { clearBudgetRedesignChart(); }, []);

  return <div id="budget-redesign-chart" class="budget-redesign-chart" ref={containerRef} />;
};

const BudgetChartCard = ({
  chart,
  onModeChange,
}: {
  chart: BudgetChartData;
  onModeChange: (v: BudgetRedesignChartMode) => void;
}) => {
  if (!chart) return null;
  return (
    <section class="pels-surface-card budget-redesign-card budget-chart-card">
      <MdElevation aria-hidden="true" />
      <div class="budget-card-header">
        <div>
          <h3 id="budget-redesign-chart-title" class="plan-card__title">{chart.chartTitle}</h3>
          <p id="budget-redesign-chart-subtitle" class="pels-card-supporting">{chart.chartSubtitle}</p>
        </div>
        <ToggleGroup
          options={[
            { value: 'progress' as const, label: 'Progress' },
            { value: 'hourlyPlan' as const, label: 'Hourly plan' },
          ]}
          value={chart.mode}
          ariaLabel="Budget chart view"
          onChange={onModeChange}
        />
      </div>
      <ChartLegend view={chart.view} showProjection={chart.showProjection} showPrice={chart.showPrice} />
      <EChartsCanvas chart={chart} />
      {chart.caveat !== null && (
        <p class="pels-card-supporting budget-chart-caveat">{chart.caveat}</p>
      )}
    </section>
  );
};

// ─── Adjust View ──────────────────────────────────────────────────────────────

const resolveReserveLabel = (controlledWeight: number): string => (
  controlledWeight >= 0.5 ? 'Conservative reserve' : 'Balanced reserve'
);

const resolveFlexibilityLabel = (priceFlexShare: number): string => {
  if (priceFlexShare <= 0.3) return 'Low flexibility';
  if (priceFlexShare >= 0.85) return 'High flexibility';
  return 'Medium flexibility';
};

const formatKw = (value: number): string => (
  Number.isFinite(value) ? `${value.toFixed(1)} kW` : '-- kW'
);

const SettingRow = ({
  label,
  hint,
  value,
}: {
  label: string;
  hint?: string;
  value: string;
}) => (
  <div class="budget-setting-row">
    <span>
      <span class="budget-setting-row__label">{label}</span>
      {hint && <small class="field__hint">{hint}</small>}
    </span>
    <span class="budget-setting-row__value">{value}</span>
  </div>
);

const BudgetAdjustView = ({ adjust }: { adjust: BudgetAdjustData }) => {
  const reserveLabel = resolveReserveLabel(adjust.controlledWeight);
  const flexibilityLabel = resolveFlexibilityLabel(adjust.priceFlexShare);
  const reactionText = Number.isFinite(adjust.hardCapKw) && Number.isFinite(adjust.safetyMarginKw)
    ? `PELS reacts at ${Math.max(0, adjust.hardCapKw - adjust.safetyMarginKw).toFixed(1)} kW.`
    : 'PELS reacts before reaching the hard cap.';

  return (
    <div id="budget-redesign-adjust-view" class="budget-redesign-view">
      <section class="pels-surface-card budget-redesign-card">
        <MdElevation aria-hidden="true" />
        <h3 class="plan-card__title">Daily energy</h3>
        <div class="budget-settings-list">
          <SettingRow
            label="Enable daily budget"
            hint="Use a daily energy budget to shape the plan."
            value={adjust.enabled ? 'On' : 'Off'}
          />
          <SettingRow
            label="Daily budget"
            hint="The selected day's energy plan."
            value={formatKWh(adjust.dailyBudgetKWh)}
          />
          <SettingRow
            label="Use cheaper hours"
            hint="Shape managed usage toward cheaper hours when prices are usable."
            value={adjust.priceShaping ? 'On' : 'Off'}
          />
        </div>
      </section>

      <details class="pels-surface-card budget-redesign-card budget-planning-behavior">
        <summary class="budget-planning-behavior__summary">
          <span class="budget-planning-behavior__heading">
            <span class="plan-card__title">Planning behavior</span>
            <small class="section-hint">{`${reserveLabel} · ${flexibilityLabel}`}</small>
          </span>
        </summary>
        <MdElevation aria-hidden="true" />
        <div class="budget-settings-list">
          <SettingRow
            label="Background usage reserve"
            hint="Daily budget held back for household usage PELS cannot move."
            value={reserveLabel.replace(' reserve', '')}
          />
          <SettingRow
            label="Managed device flexibility"
            hint="How freely PELS may shift managed-device usage toward cheaper hours."
            value={flexibilityLabel.replace(' flexibility', '')}
          />
        </div>
      </details>

      <section class="pels-surface-card budget-redesign-card">
        <MdElevation aria-hidden="true" />
        <div class="budget-card-header">
          <div>
            <h3 class="plan-card__title">Limits context</h3>
            <p class="pels-card-supporting">{reactionText}</p>
          </div>
        </div>
        <button type="button" class="btn secondary budget-context-action" data-settings-target="limits">
          Open Limits &amp; safety
        </button>
        <div class="budget-settings-list budget-settings-list--compact">
          <div class="budget-setting-row">
            <span class="budget-setting-row__label">Hard cap</span>
            <span class="budget-setting-row__value">{formatKw(adjust.hardCapKw)}</span>
          </div>
          <div class="budget-setting-row">
            <span class="budget-setting-row__label">Safety margin</span>
            <span class="budget-setting-row__value">{formatKw(adjust.safetyMarginKw)}</span>
          </div>
        </div>
      </section>
    </div>
  );
};

// ─── Root ─────────────────────────────────────────────────────────────────────

const BudgetOverviewRoot = ({
  localView,
  view,
  hero,
  chart,
  adjust,
  onLocalViewChange,
  onDayChange,
  onChartModeChange,
}: BudgetOverviewProps) => (
  <div>
    <ToggleGroup
      options={[
        { value: 'plan' as const, label: 'Plan' },
        { value: 'adjust' as const, label: 'Adjust' },
      ]}
      value={localView}
      ariaLabel="Budget view"
      onChange={onLocalViewChange}
    />
    {localView === 'plan' && (
      <div class="budget-redesign-view">
        <ToggleGroup
          options={[
            { value: 'yesterday' as const, label: 'Yesterday' },
            { value: 'today' as const, label: 'Today' },
            { value: 'tomorrow' as const, label: 'Tomorrow' },
          ]}
          value={view}
          ariaLabel="Budget day"
          onChange={onDayChange}
        />
        <BudgetHero hero={hero} />
        <BudgetChartCard chart={chart} onModeChange={onChartModeChange} />
      </div>
    )}
    {localView === 'adjust' && <BudgetAdjustView adjust={adjust} />}
  </div>
);

// ─── Mount ────────────────────────────────────────────────────────────────────

export const renderBudgetOverview = (
  surface: HTMLElement,
  props: BudgetOverviewProps,
): void => {
  render(<BudgetOverviewRoot {...props} />, surface);
};
