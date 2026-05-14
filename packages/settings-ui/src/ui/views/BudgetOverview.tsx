import { render, type ComponentChildren } from 'preact';
import { useRef, useLayoutEffect } from 'preact/hooks';
import {
  MdElevation,
  MdFilledButton,
  MdFilledSelect,
  MdFilledTextField,
  MdOutlinedButton,
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
import type { AllocationWarning } from '../dailyBudgetAllocationWarning.ts';

export type BudgetLocalView = 'plan' | 'adjust';
export type BudgetStatus = 'noPlan' | 'within' | 'tight' | 'over';
export type BudgetDeltaTone = 'ok' | 'warn' | 'alert';

export type BudgetHeroData = {
  headlineLabel: string | null;
  comparison: string;
  delta: { label: string; tone: BudgetDeltaTone } | null;
  headroomLine: string | null;
  splitLine: string | null;
  priceTagline: string | null;
  decision: string | null;
  heroTone: 'ok' | 'warn' | 'alert';
};

export type BudgetChartData = {
  payload: DailyBudgetDayPayload;
  view: BudgetRedesignDayView;
  mode: BudgetRedesignChartMode;
  showPrice: boolean;
  showProjection: boolean;
  // True when the hourly chart renders the planned-load split as two stacked
  // series (Background + Managed) instead of the single Plan series. The
  // legend follows this so its labels match the rendered fills.
  showSplit: boolean;
  costDisplay: CostDisplay;
  chartTitle: string;
  chartSubtitle: string;
  caveat: string | null;
} | null;

export type BudgetConfidenceData = {
  label: 'High' | 'Medium' | 'Low';
  percent: string;
  details: Array<{ label: string; value: string }>;
} | null;

export type BudgetComparisonChart = {
  payload: DailyBudgetDayPayload;
  view: BudgetRedesignDayView;
  costDisplay: CostDisplay;
  priceReliable: boolean;
  dataMaxOverride?: number;
};

export type BudgetAdjustData = {
  draft: BudgetAdjustDraft;
  active: BudgetAdjustDraft;
  candidate: BudgetAdjustDraft | null;
  activeChart: BudgetComparisonChart | null;
  candidateChart: BudgetComparisonChart | null;
  comparisonDayView: BudgetRedesignDayView;
  comparisonDayLabel: string;
  comparisonShowPrice: boolean;
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
  confidence: BudgetConfidenceData;
  adjust: BudgetAdjustData;
  allocationWarning: AllocationWarning | null;
  onLocalViewChange: (v: BudgetLocalView) => void;
  onDayChange: (v: BudgetRedesignDayView) => void;
  onChartModeChange: (v: BudgetRedesignChartMode) => void;
  onAdjustFieldChange: (patch: Partial<BudgetAdjustDraft>) => void;
  onPreview: () => void;
  onApply: () => void;
  onDiscard: () => void;
};

// ─── Toggle Group ─────────────────────────────────────────────────────────────

type ToggleOpt<T extends string> = { value: T; label: string; disabled?: boolean; title?: string };

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
      <MdTextButton
        key={opt.value}
        class={`day-view-toggle__button${value === opt.value ? ' is-active' : ''}`}
        aria-pressed={value === opt.value}
        disabled={opt.disabled}
        title={opt.title}
        onClick={() => onChange(opt.value)}
      >
        {opt.label}
      </MdTextButton>
    ))}
  </div>
);

// ─── Budget Hero ──────────────────────────────────────────────────────────────

const deltaChipClass = (tone: BudgetDeltaTone): string => {
  if (tone === 'alert') return 'plan-chip plan-chip--alert';
  if (tone === 'warn') return 'plan-chip plan-chip--warn';
  return 'plan-chip plan-chip--ok';
};

const BudgetHero = ({ hero }: { hero: BudgetHeroData }) => (
  <section class="plan-hero" data-tone={hero.heroTone}>
    <div id="budget-plan-summary" class="plan-hero__section">
      {hero.headlineLabel !== null && (
        <span class="plan-hero__section-label">{hero.headlineLabel}</span>
      )}
      <div class="plan-hero__headline-row">
        <div id="budget-redesign-comparison" class="plan-hero__headline">{hero.comparison}</div>
        {hero.delta && (
          <span id="budget-redesign-delta" class={deltaChipClass(hero.delta.tone)}>
            {hero.delta.label}
          </span>
        )}
      </div>
      {hero.headroomLine !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{hero.headroomLine}</div>
      )}
      {hero.splitLine !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{hero.splitLine}</div>
      )}
      {hero.priceTagline !== null && (
        <div class="plan-hero__subline plan-hero__subline--muted">{hero.priceTagline}</div>
      )}
      {hero.decision !== null && (
        <p class="plan-hero__decision">{hero.decision}</p>
      )}
    </div>
  </section>
);

// ─── Allocation Warning ───────────────────────────────────────────────────────

const AllocationWarningBanner = ({
  warning,
  onAdjustClick,
}: {
  warning: AllocationWarning;
  onAdjustClick: () => void;
}) => (
  <section
    id="budget-redesign-allocation-warning"
    class="banner banner--warning budget-redesign-allocation-warning"
    role="status"
  >
    <span class="banner__icon" aria-hidden="true">⚠️</span>
    <div class="banner__body">
      <p class="banner__title">{warning.title}</p>
      <p class="banner__text">{warning.body}</p>
    </div>
    <MdTextButton
      id="budget-redesign-allocation-warning-action"
      onClick={onAdjustClick}
    >
      Adjust budget
    </MdTextButton>
  </section>
);

// ─── Budget Chart ─────────────────────────────────────────────────────────────

type LegendItem = { label: string; cls: string };

const ChartLegend = ({
  view,
  showProjection,
  showPrice,
  showSplit,
}: {
  view: BudgetRedesignDayView;
  showProjection: boolean;
  showPrice: boolean;
  showSplit: boolean;
}) => {
  const items: LegendItem[] = [
    ...(view !== 'tomorrow' ? [{ label: 'Actual', cls: 'budget-chart-legend__swatch--actual' }] : []),
    // When the chart renders the planned-load split, the bars are Background +
    // Managed; show those swatches instead of the single Plan swatch so the
    // legend always names what the user actually sees.
    ...(showSplit
      ? [
        { label: 'Background', cls: 'budget-chart-legend__swatch--background' },
        { label: 'Managed', cls: 'budget-chart-legend__swatch--managed' },
      ]
      : [{ label: 'Plan', cls: '' }]),
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
        showSplit={chart.showSplit}
      />
      <EChartsCanvas chart={chart} />
      {chart.caveat !== null && (
        <p class="pels-card-supporting budget-chart-caveat">{chart.caveat}</p>
      )}
    </section>
  );
};

// ─── Plan Confidence ─────────────────────────────────────────────────────────

const BudgetConfidenceCard = ({ confidence }: { confidence: BudgetConfidenceData }) => {
  if (!confidence) return null;
  return (
    <section class="pels-surface-card budget-redesign-card budget-confidence-card">
      <MdElevation aria-hidden="true" />
      <div class="budget-card-header">
        <div>
          <h3 class="plan-card__title">Plan confidence</h3>
          <p class="pels-card-supporting">
            How well PELS can predict this plan from recent complete days.
          </p>
        </div>
        <span id="budget-plan-confidence-value" class="budget-confidence-card__value">
          <span>{confidence.label}</span>
          <small>{confidence.percent}</small>
        </span>
      </div>
      <details class="budget-confidence-card__details">
        <summary>What this means</summary>
        <p class="pels-card-supporting budget-confidence-card__explanation">
          Based on recent complete days. Higher confidence means your usage pattern has been regular
          and managed devices have followed earlier plans.
        </p>
        {confidence.details.length > 0 && (
          <div class="budget-settings-list budget-settings-list--compact">
            {confidence.details.map((row) => (
              <div key={row.label} class="budget-setting-row">
                <span class="budget-setting-row__label">{row.label}</span>
                <span class="budget-setting-row__value">{row.value}</span>
              </div>
            ))}
          </div>
        )}
      </details>
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

type ComparisonRow = { label: string; current: string; candidate: string; delta?: string };

const formatSignedKWhDelta = (diff: number): string => {
  if (!Number.isFinite(diff) || diff === 0) return '';
  const sign = diff > 0 ? '+' : '−';
  return `${sign}${formatKWh(Math.abs(diff))}`;
};

const computeComparison = (active: BudgetAdjustDraft, candidate: BudgetAdjustDraft): ComparisonRow[] => {
  const rows: ComparisonRow[] = [];
  if (active.enabled !== candidate.enabled) {
    rows.push({ label: 'Enable daily budget', current: onOff(active.enabled), candidate: onOff(candidate.enabled) });
  }
  if (active.dailyBudgetKWh !== candidate.dailyBudgetKWh) {
    const delta = formatSignedKWhDelta(candidate.dailyBudgetKWh - active.dailyBudgetKWh);
    rows.push({
      label: 'Daily budget',
      current: formatKWh(active.dailyBudgetKWh),
      candidate: formatKWh(candidate.dailyBudgetKWh),
      ...(delta ? { delta } : {}),
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
      mode: 'hourlyPlan',
      view: chart.view,
      priceReliable: chart.priceReliable,
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
  const {
    draft,
    active,
    candidate,
    activeChart,
    candidateChart,
    comparisonDayLabel,
    comparisonShowPrice,
    status,
    busy,
  } = adjust;
  const usableCapacityKw = Number.isFinite(adjust.hardCapKw) && Number.isFinite(adjust.safetyMarginKw)
    ? Math.max(0, adjust.hardCapKw - adjust.safetyMarginKw)
    : null;
  const reactionText = usableCapacityKw !== null
    ? `Safe pace now ${formatKw(usableCapacityKw)} — hard cap minus safety margin.`
    : 'Safe pace stays below the hard cap.';
  const recommendedMaxKWh = usableCapacityKw !== null && usableCapacityKw > 0
    ? Math.min(MAX_DAILY_BUDGET_KWH, usableCapacityKw * 24)
    : null;
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
              <FieldHint>
                The selected day's energy plan.
                <span class="field__hint-range">{` Range ${MIN_DAILY_BUDGET_KWH}–${MAX_DAILY_BUDGET_KWH} kWh.`}</span>
                {recommendedMaxKWh !== null && recommendedMaxKWh < MAX_DAILY_BUDGET_KWH ? (
                  <span class="field__hint-range">{` Recommended up to ${formatKWh(recommendedMaxKWh, 1)} (hourly limit × 24h).`}</span>
                ) : null}
              </FieldHint>
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

      <details class="pels-surface-card budget-redesign-card budget-planning-behavior" open>
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
              <p class="pels-card-supporting">{comparisonDayLabel}</p>
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
                    {row.delta && (
                      <span class="budget-comparison__delta">{`(${row.delta})`}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div class="budget-comparison__legend">
            <span class="budget-comparison__legend-item">
              <span class="budget-comparison__legend-swatch budget-comparison__legend-swatch--background" />
              Background
            </span>
            <span class="budget-comparison__legend-item">
              <span class="budget-comparison__legend-swatch budget-comparison__legend-swatch--managed" />
              Managed
            </span>
            {comparisonShowPrice && (
              <span class="budget-comparison__legend-item">
                <span class="budget-comparison__legend-swatch budget-comparison__legend-swatch--price" />
                Price
              </span>
            )}
          </div>
          {activeChart && (
            <ComparisonChart
              label="Current"
              chart={activeChart}
              testId="budget-comparison-chart-current"
            />
          )}
          {candidateChart && (
            <ComparisonChart
              label="Preview"
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
            <h3 class="plan-card__title">Current limits</h3>
            <p class="pels-card-supporting">{reactionText}</p>
          </div>
        </div>
        <MdOutlinedButton class="btn secondary budget-context-action" data-settings-target="limits">
          Open Limits &amp; safety
        </MdOutlinedButton>
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
  confidence,
  adjust,
  allocationWarning,
  onLocalViewChange,
  onDayChange,
  onChartModeChange,
  onAdjustFieldChange,
  onPreview,
  onApply,
  onDiscard,
}: BudgetOverviewProps) => {
  const budgetEnabled = adjust.active.enabled;
  return (
  <div>
    <ToggleGroup
      options={[
        {
          value: 'plan' as const,
          label: 'Plan',
          disabled: !budgetEnabled,
          title: budgetEnabled ? undefined : 'Enable daily budget to see the plan.',
        },
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
        {allocationWarning && (
          <AllocationWarningBanner
            warning={allocationWarning}
            onAdjustClick={() => onLocalViewChange('adjust')}
          />
        )}
        <BudgetConfidenceCard confidence={confidence} />
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
};

// ─── Mount ────────────────────────────────────────────────────────────────────

export const renderBudgetOverview = (
  surface: HTMLElement,
  props: BudgetOverviewProps,
): void => {
  render(<BudgetOverviewRoot {...props} />, surface);
};
