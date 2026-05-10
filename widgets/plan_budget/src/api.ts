import type { CombinedPriceData, CombinedPriceEntry } from '../../../lib/dailyBudget/dailyBudgetPrices';
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

const flattenStoreToCombinedPriceData = (value: unknown): CombinedPriceData | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as { days?: unknown; lastFetched?: unknown; priceUnit?: unknown };
  if (!record.days || typeof record.days !== 'object' || Array.isArray(record.days)) return null;
  const days = record.days as Record<string, unknown>;
  const collected: CombinedPriceEntry[] = Object.values(days).flatMap((day) => {
    if (!day || typeof day !== 'object') return [];
    const hours = (day as { hours?: unknown }).hours;
    return Array.isArray(hours) ? hours as CombinedPriceEntry[] : [];
  });
  const prices = [...collected].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  return {
    prices,
    lastFetched: typeof record.lastFetched === 'string' ? record.lastFetched : undefined,
    priceUnit: typeof record.priceUnit === 'string' ? record.priceUnit : undefined,
  };
};

export const getChart = async ({ homey, query }: WidgetApiContext): Promise<PlanPriceWidgetPayload> => {
  const app = homey.app;
  const snapshot = typeof app?.getDailyBudgetUiPayload === 'function'
    ? app.getDailyBudgetUiPayload()
    : null;
  const combinedPrices = flattenStoreToCombinedPriceData(homey.settings.get(COMBINED_PRICES_SETTING));

  return buildPlanPriceWidgetPayload({
    snapshot,
    combinedPrices,
    target: query?.day,
  });
};
