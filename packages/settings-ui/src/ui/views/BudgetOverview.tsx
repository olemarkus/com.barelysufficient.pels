import { render, type ComponentChildren } from 'preact';
import { useRef, useLayoutEffect } from 'preact/hooks';
import {
  MdElevation,
  MdFilledButton,
  MdFilledSelect,
  MdFilledTextField,
  MdSelectOption,
  MdSwitch,
  MdTextButton,
} from './materialWebJSX.tsx';
import {
  renderBudgetRedesignChart,
  clearBudgetRedesignChart,
  type BudgetRedesignChartMode,
  type BudgetRedesignDayView,
} from '../budgetRedesignChart.ts';
import type { DailyBudgetDayPayload } from '../../../../contracts/src/dailyBudgetTypes.ts';
import type { CostDisplay } from '../dailyBudgetCost.ts';
import { formatKWh } from '../dailyBudgetFormat.ts';
import {
  MAX_DAILY_BUDGET_KWH,
  MIN_DAILY_BUDGET_KWH,
  PRICE_FLEX_HIGH,
  PRICE_FLEX_LOW,
  PRICE_FLEX_MEDIUM,
  UNMANAGED_RESERVE_BALANCED_MODE,
  UNMANAGED_RESERVE_CONSERVATIVE_MODE,
} from '../../../../contracts/src/dailyBudgetConstants.ts';
import type { BudgetAdjustDraft, BudgetAdjustStatus } from '../budgetAdjustController.ts';

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

export type BudgetComparisonChart = {
  payload: DailyBudgetDayPayload;
  view: BudgetRedesignDayView;
  costDisplay: CostDisplay;
  dataMaxOverride?: number;
};

export type BudgetAdjustData = {
  draft: BudgetAdjustDraft;
  active: BudgetAdjustDraft;
  candidate: BudgetAdjustDraft | null;
  activeChart: BudgetComparisonChart | null;
  candidateChart: BudgetComparisonChart | null;
  status: BudgetAdjustStatus;
  busy: boolean;
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
  onAdjustFieldChange: (patch: Partial<BudgetAdjustDraft>) => void;
  onPreview: () => void;
  onApply: () => void;
  onDiscard: () => void;
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

  useLayoutEffect(() => () => {
    if (containerRef.current) clearBudgetRedesignChart(containerRef.current);
  }, []);

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
      <ChartLegend
        view={chart.view}
        showProjection={chart.showProjection}
        showPrice={chart.showPrice}
      />
      <EChartsCanvas chart={chart} />
      {chart.caveat !== null && (
        <p class="pels-card-supporting budget-chart-caveat">{chart.caveat}</p>
      )}
    </section>
  );
};

// ─── Adjust View ──────────────────────────────────────────────────────────────

const reserveLabelFor = (controlledWeight: number): string => (
  controlledWeight >= 0.5 ? 'Conservative' : 'Balanced'
);

const flexibilityLabelFor = (priceFlexShare: number): string => {
  if (priceFlexShare <= PRICE_FLEX_LOW) return 'Low';
  if (priceFlexShare >= PRICE_FLEX_HIGH) return 'High';
  return 'Medium';
};

const formatKw = (value: number): string => (
  Number.isFinite(value) ? `${value.toFixed(1)} kW` : '-- kW'
);

const onOff = (value: boolean): string => (value ? 'On' : 'Off');

type ComparisonRow = { label: string; current: string; candidate: string };

const computeComparison = (active: BudgetAdjustDraft, candidate: BudgetAdjustDraft): ComparisonRow[] => {
  const rows: ComparisonRow[] = [];
  if (active.enabled !== candidate.enabled) {
    rows.push({ label: 'Enable daily budget', current: onOff(active.enabled), candidate: onOff(candidate.enabled) });
  }
  if (active.dailyBudgetKWh !== candidate.dailyBudgetKWh) {
    rows.push({
      label: 'Daily budget',
      current: formatKWh(active.dailyBudgetKWh),
      candidate: formatKWh(candidate.dailyBudgetKWh),
    });
  }
  if (active.priceShaping !== candidate.priceShaping) {
    rows.push({
      label: 'Use cheaper hours',
      current: onOff(active.priceShaping),
      candidate: onOff(candidate.priceShaping),
    });
  }
  if (active.controlledWeight !== candidate.controlledWeight) {
    rows.push({
      label: 'Background usage reserve',
      current: reserveLabelFor(active.controlledWeight),
      candidate: reserveLabelFor(candidate.controlledWeight),
    });
  }
  if (active.priceFlexShare !== candidate.priceFlexShare) {
    rows.push({
      label: 'Managed device flexibility',
      current: flexibilityLabelFor(active.priceFlexShare),
      candidate: flexibilityLabelFor(candidate.priceFlexShare),
    });
  }
  return rows;
};

const FieldHint = ({ children }: { children: ComponentChildren }) => (
  <small class="field__hint">{children}</small>
);

const ComparisonChart = ({
  label,
  chart,
  testId,
}: {
  label: string;
  chart: BudgetComparisonChart;
  testId: string;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    renderBudgetRedesignChart({
      container,
      payload: chart.payload,
      mode: 'progress',
      view: chart.view,
      priceReliable: false,
      costDisplay: chart.costDisplay,
      dataMaxOverride: chart.dataMaxOverride,
    });
  });
  useLayoutEffect(() => () => {
    if (containerRef.current) clearBudgetRedesignChart(containerRef.current);
  }, []);
  return (
    <div class="budget-comparison-chart">
      <h4 class="budget-comparison-chart__title">{label}</h4>
      <div class="budget-redesign-chart" data-testid={testId} ref={containerRef} />
    </div>
  );
};

const BudgetAdjustView = ({
  adjust,
  onAdjustFieldChange,
  onPreview,
  onApply,
  onDiscard,
}: {
  adjust: BudgetAdjustData;
  onAdjustFieldChange: (patch: Partial<BudgetAdjustDraft>) => void;
  onPreview: () => void;
  onApply: () => void;
  onDiscard: () => void;
}) => {
  const { draft, active, candidate, activeChart, candidateChart, status, busy } = adjust;
  const reactionText = Number.isFinite(adjust.hardCapKw) && Number.isFinite(adjust.safetyMarginKw)
    ? `PELS reacts at ${Math.max(0, adjust.hardCapKw - adjust.safetyMarginKw).toFixed(1)} kW.`
    : 'PELS reacts before reaching the hard cap.';
  const reserveValueText = `${reserveLabelFor(draft.controlledWeight)} reserve`;
  const flexibilityValueText = `${flexibilityLabelFor(draft.priceFlexShare)} flexibility`;
  const comparisonRows = candidate ? computeComparison(active, candidate) : [];

  const onEnableChange = (event: Event) => {
    const target = event.currentTarget as HTMLElement & { selected?: boolean };
    onAdjustFieldChange({ enabled: Boolean(target.selected) });
  };
  const onPriceShapingChange = (event: Event) => {
    const target = event.currentTarget as HTMLElement & { selected?: boolean };
    onAdjustFieldChange({ priceShaping: Boolean(target.selected) });
  };
  const onKWhChange = (event: Event) => {
    const target = event.currentTarget as HTMLElement & { value?: string };
    const parsed = Number.parseFloat(target.value ?? '');
    if (!Number.isFinite(parsed)) return;
    onAdjustFieldChange({ dailyBudgetKWh: parsed });
  };
  const onReserveChange = (event: Event) => {
    const target = event.currentTarget as HTMLElement & { value?: string };
    const parsed = Number.parseFloat(target.value ?? '');
    if (!Number.isFinite(parsed)) return;
    onAdjustFieldChange({ controlledWeight: parsed });
  };
  const onFlexChange = (event: Event) => {
    const target = event.currentTarget as HTMLElement & { value?: string };
    const parsed = Number.parseFloat(target.value ?? '');
    if (!Number.isFinite(parsed)) return;
    onAdjustFieldChange({ priceFlexShare: parsed });
  };

  return (
    <div id="budget-redesign-adjust-view" class="budget-redesign-view">
      <section class="pels-surface-card budget-redesign-card">
        <MdElevation aria-hidden="true" />
        <h3 class="plan-card__title">Daily energy</h3>
        <div class="budget-settings-list">
          <div class="budget-setting-row budget-setting-row--editable">
            <span>
              <span class="budget-setting-row__label">Enable daily budget</span>
              <FieldHint>Use a daily energy budget to shape the plan.</FieldHint>
            </span>
            <MdSwitch
              id="budget-redesign-enabled"
              aria-label="Enable daily budget"
              {...(draft.enabled ? { selected: true } : {})}
              onChange={onEnableChange}
            />
          </div>
          <div class="budget-setting-row budget-setting-row--editable">
            <span>
              <span class="budget-setting-row__label">Daily budget</span>
              <FieldHint>The selected day's energy plan.</FieldHint>
            </span>
            <MdFilledTextField
              id="budget-redesign-kwh"
              class="budget-redesign-field budget-redesign-field--kwh"
              aria-label="Daily budget in kWh"
              type="number"
              suffixText="kWh"
              min={MIN_DAILY_BUDGET_KWH}
              max={MAX_DAILY_BUDGET_KWH}
              step="0.1"
              inputMode="decimal"
              value={String(draft.dailyBudgetKWh)}
              {...(draft.enabled ? {} : { disabled: true })}
              onChange={onKWhChange}
            />
          </div>
          <div class="budget-setting-row budget-setting-row--editable">
            <span>
              <span class="budget-setting-row__label">Use cheaper hours</span>
              <FieldHint>Shape managed usage toward cheaper hours when prices are usable.</FieldHint>
            </span>
            <MdSwitch
              id="budget-redesign-price-shaping"
              aria-label="Use cheaper hours"
              {...(draft.priceShaping ? { selected: true } : {})}
              onChange={onPriceShapingChange}
            />
          </div>
        </div>
      </section>

      <details class="pels-surface-card budget-redesign-card budget-planning-behavior">
        <summary class="budget-planning-behavior__summary">
          <span class="budget-planning-behavior__heading">
            <span class="plan-card__title">Planning behavior</span>
            <small class="section-hint">{`${reserveValueText} · ${flexibilityValueText}`}</small>
          </span>
        </summary>
        <MdElevation aria-hidden="true" />
        <div class="budget-settings-list">
          <div class="budget-setting-row budget-setting-row--editable">
            <span>
              <span class="budget-setting-row__label">Background usage reserve</span>
              <FieldHint>Daily budget held back for household usage PELS cannot move.</FieldHint>
            </span>
            <MdFilledSelect
              id="budget-redesign-controlled-weight"
              class="budget-redesign-field budget-redesign-field--select"
              aria-label="Background usage reserve"
              value={String(draft.controlledWeight)}
              onChange={onReserveChange}
            >
              <MdSelectOption value={String(UNMANAGED_RESERVE_BALANCED_MODE)}>
                <div slot="headline">Balanced</div>
              </MdSelectOption>
              <MdSelectOption value={String(UNMANAGED_RESERVE_CONSERVATIVE_MODE)}>
                <div slot="headline">Conservative</div>
              </MdSelectOption>
            </MdFilledSelect>
          </div>
          <div class="budget-setting-row budget-setting-row--editable">
            <span>
              <span class="budget-setting-row__label">Managed device flexibility</span>
              <FieldHint>How freely PELS may shift managed-device usage toward cheaper hours.</FieldHint>
            </span>
            <MdFilledSelect
              id="budget-redesign-price-flex-share"
              class="budget-redesign-field budget-redesign-field--select"
              aria-label="Managed device flexibility"
              value={String(draft.priceFlexShare)}
              onChange={onFlexChange}
            >
              <MdSelectOption value={String(PRICE_FLEX_LOW)}>
                <div slot="headline">Low</div>
              </MdSelectOption>
              <MdSelectOption value={String(PRICE_FLEX_MEDIUM)}>
                <div slot="headline">Medium</div>
              </MdSelectOption>
              <MdSelectOption value={String(PRICE_FLEX_HIGH)}>
                <div slot="headline">High</div>
              </MdSelectOption>
            </MdFilledSelect>
          </div>
        </div>
      </details>

      {status === 'pending' && candidate && (
        <section
          id="budget-redesign-comparison"
          class="pels-surface-card budget-redesign-card budget-redesign-comparison"
        >
          <MdElevation aria-hidden="true" />
          <div class="budget-card-header">
            <div>
              <h3 class="plan-card__title">Compare with current</h3>
              <p class="pels-card-supporting">
                {comparisonRows.length === 0
                  ? 'No setting differences — the candidate plan reflects fresh data only.'
                  : 'Apply to switch to the candidate plan, or discard to keep current.'}
              </p>
            </div>
          </div>
          {comparisonRows.length > 0 && (
            <div class="budget-settings-list budget-settings-list--compact">
              {comparisonRows.map((row) => (
                <div key={row.label} class="budget-setting-row budget-setting-row--comparison">
                  <span class="budget-setting-row__label">{row.label}</span>
                  <span class="budget-setting-row__value">
                    <span class="budget-comparison__current">{row.current}</span>
                    <span class="budget-comparison__arrow" aria-hidden="true">{'→'}</span>
                    <span class="budget-comparison__candidate">{row.candidate}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {activeChart && (
            <ComparisonChart
              label="Current plan"
              chart={activeChart}
              testId="budget-comparison-chart-current"
            />
          )}
          {candidateChart && (
            <ComparisonChart
              label="Preview plan"
              chart={candidateChart}
              testId="budget-comparison-chart-preview"
            />
          )}
        </section>
      )}

      {status !== 'clean' && (
        <div class="budget-redesign-actions" role="group" aria-label="Daily budget actions">
          {status === 'dirty' && (
            <MdFilledButton
              id="budget-redesign-preview"
              {...(busy ? { disabled: true } : {})}
              onClick={onPreview}
            >
              {busy ? 'Previewing…' : 'Preview changes'}
            </MdFilledButton>
          )}
          {status === 'pending' && (
            <>
              <MdFilledButton
                id="budget-redesign-apply"
                {...(busy ? { disabled: true } : {})}
                onClick={onApply}
              >
                {busy ? 'Applying…' : 'Apply changes'}
              </MdFilledButton>
              <MdTextButton
                id="budget-redesign-discard"
                {...(busy ? { disabled: true } : {})}
                onClick={onDiscard}
              >
                Discard preview
              </MdTextButton>
            </>
          )}
        </div>
      )}

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
  onAdjustFieldChange,
  onPreview,
  onApply,
  onDiscard,
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
    {localView === 'adjust' && (
      <BudgetAdjustView
        adjust={adjust}
        onAdjustFieldChange={onAdjustFieldChange}
        onPreview={onPreview}
        onApply={onApply}
        onDiscard={onDiscard}
      />
    )}
  </div>
);

// ─── Mount ────────────────────────────────────────────────────────────────────

export const renderBudgetOverview = (
  surface: HTMLElement,
  props: BudgetOverviewProps,
): void => {
  render(<BudgetOverviewRoot {...props} />, surface);
};
