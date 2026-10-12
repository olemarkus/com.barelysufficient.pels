import type { BudgetOverviewProps } from '../../src/ui/views/BudgetOverview.tsx';

/** What a Budget overview spec states about the page it renders. */
type BudgetOverviewScenario = {
  localView: BudgetOverviewProps['localView'];
  hero: Pick<BudgetOverviewProps['hero'], 'headlineLabel' | 'comparison' | 'split'>;
  /** The daily budget model, as both the saved settings and the Adjust draft. */
  budget: { enabled: boolean; dailyBudgetKWh: number };
  weatherInsight: BudgetOverviewProps['weatherInsight'];
};

/**
 * Props for the Budget overview with nothing a render spec is not about: today's
 * view with no chart, confidence, delta, cost, recourse, price lines or
 * decision, a clean Adjust view with no candidate and no price shaping, a
 * 12 kW capacity limit with 1 kW margin as the planning ceiling, no allocation
 * warning, price chip or scope line, a return to the Plan view, and no-op
 * callbacks. A spec states its view, hero, budget and weather insight, and
 * overrides the rest.
 */
export const budgetOverviewProps = (
  scenario: BudgetOverviewScenario,
  overrides: Partial<BudgetOverviewProps> = {},
): BudgetOverviewProps => {
  const model = {
    enabled: scenario.budget.enabled,
    dailyBudgetKWh: scenario.budget.dailyBudgetKWh,
    priceShaping: false,
    controlledWeight: 0,
    priceFlexShare: 0.6,
  };
  return {
    localView: scenario.localView,
    view: 'today',
    hero: {
      headlineLabel: scenario.hero.headlineLabel,
      comparison: scenario.hero.comparison,
      delta: null,
      budgetRemainingLine: null,
      estimatedCost: null,
      recourse: null,
      split: scenario.hero.split,
      priceTagline: null,
      exportPriceLine: null,
      decision: null,
      heroTone: 'ok',
    },
    chart: null,
    confidence: null,
    adjust: {
      draft: { ...model },
      active: { ...model },
      candidate: null,
      activeChart: null,
      candidateChart: null,
      comparisonDayView: 'today',
      comparisonDayLabel: 'Today',
      comparisonShowPrice: false,
      status: 'clean',
      busy: false,
      powerLimitForm: {
        capacityEnabled: true, gridImportEnabled: false, limitKw: 12, marginKw: 1, gridImportLimitKw: null,
      },
      planningCeiling: { limit: 'capacity', kw: 11 },
    },
    allocationWarning: null,
    priceLevelChip: null,
    weatherInsight: scenario.weatherInsight,
    mainHomeScopeLine: null,
    adjustReturnTarget: 'plan',
    onReturnToSettings: () => {},
    onShowUsage: () => {},
    onLocalViewChange: () => {},
    onDayChange: () => {},
    onChartModeChange: () => {},
    onChartUnitChange: () => {},
    onAdjustFieldChange: () => {},
    onPreview: () => {},
    onApply: () => {},
    onDiscard: () => {},
    ...overrides,
  };
};
