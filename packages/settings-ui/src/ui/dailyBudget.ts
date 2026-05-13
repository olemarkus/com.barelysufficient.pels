import type { DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { type CostDisplay } from './dailyBudgetCost.ts';
import { getPricesReadModel } from './prices.ts';
import { initBudgetRedesignHandlers, renderBudgetRedesign, type BudgetDayView } from './budgetRedesign.ts';
import { setBudgetAdjustRefresh } from './budgetAdjustController.ts';

const DEFAULT_COST_UNIT = 'kr';
const DEFAULT_COST_DIVISOR = 100;

let currentDailyBudgetView: BudgetDayView = 'today';
let latestDailyBudgetPayload: DailyBudgetUiPayload | null = null;
let costDisplay: CostDisplay = { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };

const resolveCostDisplay = (combinedPrices: unknown | null): CostDisplay => {
  if (!combinedPrices || typeof combinedPrices !== 'object') {
    return { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };
  }
  const { priceScheme, priceUnit } = combinedPrices as { priceScheme?: unknown; priceUnit?: unknown };
  if (priceScheme === 'flow' || priceScheme === 'homey') {
    const unit = typeof priceUnit === 'string' && priceUnit !== 'price units' ? priceUnit : '';
    return { unit, divisor: 1 };
  }
  return { unit: DEFAULT_COST_UNIT, divisor: DEFAULT_COST_DIVISOR };
};

const renderDailyBudget = (payload: DailyBudgetUiPayload | null) => {
  latestDailyBudgetPayload = payload;
  renderBudgetRedesign(payload, currentDailyBudgetView, costDisplay);
};

export const rerenderDailyBudget = () => {
  renderDailyBudget(latestDailyBudgetPayload);
};

export const refreshDailyBudgetPlan = async (payloadOverride?: DailyBudgetUiPayload | null) => {
  try {
    const hasExplicitPayload = payloadOverride !== undefined;
    const [payload, combinedPrices] = await Promise.all([
      hasExplicitPayload
        ? Promise.resolve(payloadOverride)
        : callApi<DailyBudgetUiPayload | null>('GET', '/daily_budget'),
      getPricesReadModel().then((prices) => prices.combinedPrices).catch(() => null),
    ]);
    costDisplay = resolveCostDisplay(combinedPrices);
    renderDailyBudget(payload);
  } catch (error) {
    await logSettingsError('Failed to load daily budget plan', error, 'refreshDailyBudgetPlan');
    renderDailyBudget(null);
  }
};

const setDailyBudgetView = (view: BudgetDayView) => {
  if (currentDailyBudgetView === view) return;
  currentDailyBudgetView = view;
  renderDailyBudget(latestDailyBudgetPayload);
};

export const initDailyBudgetHandlers = () => {
  initBudgetRedesignHandlers(setDailyBudgetView);
  setBudgetAdjustRefresh(async (args) => {
    await refreshDailyBudgetPlan(args?.payload);
  });
};
