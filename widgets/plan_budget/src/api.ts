import type { CombinedPriceData, CombinedPriceEntry } from '../../../lib/dailyBudget/dailyBudgetPrices';
import type { DailyBudgetHostApi } from '../../../packages/contracts/src/widgetHostApi';
import { buildPlanPriceWidgetPayload } from './planPriceWidgetPayload';
import type { PlanPriceWidgetPayload } from './planPriceWidgetTypes';

const COMBINED_PRICES_SETTING = 'combined_prices';

type WidgetApiContext = {
  homey: {
    app?: DailyBudgetHostApi;
    settings: {
      get: (key: string) => unknown;
    };
  };
  query?: {
    day?: string;
  };
};

const collectV2Hours = (days: Record<string, unknown>): CombinedPriceEntry[] => (
  Object.values(days).flatMap((day) => {
    if (!day || typeof day !== 'object') return [];
    const hours = (day as { hours?: unknown }).hours;
    return Array.isArray(hours) ? hours as CombinedPriceEntry[] : [];
  })
);

const resolvePriceScheme = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const scheme = (value as { priceScheme?: unknown }).priceScheme;
  return typeof scheme === 'string' ? scheme : undefined;
};

const flattenStoreToCombinedPriceData = (value: unknown): CombinedPriceData | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as { days?: unknown; prices?: unknown; lastFetched?: unknown; priceUnit?: unknown };
  // The widget runs in a separate JS context; if it loads before the app has
  // had a chance to persist the V1 → V2 migration via readPriceStore, accept
  // the legacy `{ prices: [...] }` shape directly so charts render instead of
  // staying empty.
  const isV2 = record.days && typeof record.days === 'object' && !Array.isArray(record.days);
  const isV1 = Array.isArray(record.prices);
  if (!isV2 && !isV1) return null;
  const collected = isV2
    ? collectV2Hours(record.days as Record<string, unknown>)
    : record.prices as CombinedPriceEntry[];
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
  const rawCombinedPrices = homey.settings.get(COMBINED_PRICES_SETTING);
  const combinedPrices = flattenStoreToCombinedPriceData(rawCombinedPrices);

  return buildPlanPriceWidgetPayload({
    snapshot,
    combinedPrices,
    target: query?.day,
    priceScheme: resolvePriceScheme(rawCombinedPrices),
  });
};
