import type { DailyBudgetUiPayload } from '../../../contracts/src/dailyBudgetTypes.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { type CostDisplay } from './dailyBudgetCost.ts';
import { getPricesReadModel } from './prices.ts';
import {
  initBudgetRedesignHandlers,
  renderBudgetRedesign,
  updateBudgetPriceLevel,
  type BudgetDayView,
} from './budgetRedesign.ts';
import { setBudgetAdjustRefresh } from './budgetAdjustController.ts';
import { resolveCostDisplayFromCombinedPrices } from './priceUnit.ts';

let currentDailyBudgetView: BudgetDayView = 'today';
let latestDailyBudgetPayload: DailyBudgetUiPayload | null = null;
let costDisplay: CostDisplay = resolveCostDisplayFromCombinedPrices(null);

const renderDailyBudget = (payload: DailyBudgetUiPayload | null) => {
  latestDailyBudgetPayload = payload;
  renderBudgetRedesign(payload, currentDailyBudgetView, costDisplay);
};

export const rerenderDailyBudget = () => {
  renderDailyBudget(latestDailyBudgetPayload);
};

// Side-channel for power-derived signals that aren't carried on the daily
// budget payload itself. Price-level (cheap/expensive) is shared between the
// Overview hero and the Budget page; piping it through realtime keeps both
// surfaces aligned without rebuilding the budget payload on every tick.
export const updateBudgetPower = (
  power: { priceLevel?: string | null } | null,
): void => {
  updateBudgetPriceLevel(power?.priceLevel ?? null);
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
    costDisplay = resolveCostDisplayFromCombinedPrices(combinedPrices);
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
