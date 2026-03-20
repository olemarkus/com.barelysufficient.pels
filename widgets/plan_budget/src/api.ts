import type { CombinedPriceData } from '../../../lib/dailyBudget/dailyBudgetPrices';
import type { DailyBudgetUiPayload } from '../../../lib/dailyBudget/dailyBudgetTypes';
import { buildPlanPriceWidgetPayload } from './planPriceWidgetPayload';
import type { PlanPriceWidgetPayload } from './planPriceWidgetTypes';

const COMBINED_PRICES_SETTING = 'combined_prices';

type WidgetApiApp = {
  getDailyBudgetUiPayload?: () => DailyBudgetUiPayload | null;
};

type WidgetApiContext = {
  homey: {
    app?: WidgetApiApp;
    settings: {
      get: (key: string) => unknown;
    };
  };
  query?: {
    day?: string;
  };
};

const isCombinedPriceData = (value: unknown): value is CombinedPriceData => (
  typeof value === 'object' && value !== null
);

export const getChart = async ({ homey, query }: WidgetApiContext): Promise<PlanPriceWidgetPayload> => {
  const app = homey.app;
  const snapshot = typeof app?.getDailyBudgetUiPayload === 'function'
    ? app.getDailyBudgetUiPayload()
    : null;
  const combinedPricesValue = homey.settings.get(COMBINED_PRICES_SETTING);

  return buildPlanPriceWidgetPayload({
    snapshot,
    combinedPrices: isCombinedPriceData(combinedPricesValue) ? combinedPricesValue : null,
    target: query?.day,
  });
};
