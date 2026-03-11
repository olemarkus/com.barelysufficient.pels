import { resolveCurrentPriceFromCombined } from '../price/priceLowestFlowEvaluator';
import { getHourStartInTimeZone } from '../utils/dateUtils';
import { normalizeError } from '../utils/errorUtils';

type LowestPriceTriggerCardId = 'price_lowest_before' | 'price_lowest_today';

type LowestPriceTriggerCard = {
  trigger?: (tokens?: Record<string, unknown>, state?: Record<string, unknown>) => Promise<unknown>;
};

export type PriceLowestTriggerCheckerDeps = {
  getNow: () => Date;
  getTimeZone: () => string;
  getCombinedHourlyPrices: () => unknown;
  getTriggerCard: (id: LowestPriceTriggerCardId) => LowestPriceTriggerCard;
  logDebug: (message: string) => void;
  error: (message: string, error: Error) => void;
};

const PRICE_LOWEST_TRIGGER_CHECK_INTERVAL_MS = 30 * 1000;

const getCurrentLocalHourKey = (now: Date, timeZone: string): string | undefined => {
  const hourStartMs = getHourStartInTimeZone(now, timeZone);
  if (!Number.isFinite(hourStartMs)) return undefined;
  return `${timeZone}:${new Date(hourStartMs).toISOString()}`;
};

const triggerLowestPriceCards = async (params: {
  deps: PriceLowestTriggerCheckerDeps;
  now: Date;
  timeZone: string;
  hourKey: string;
}): Promise<void> => {
  const { deps, now, timeZone, hourKey } = params;
  const currentPriceResult = resolveCurrentPriceFromCombined({
    combinedPrices: deps.getCombinedHourlyPrices(),
    timeZone,
    now,
  });
  const currentPrice = currentPriceResult.currentPrice;
  if (typeof currentPrice !== 'number' || !Number.isFinite(currentPrice)) {
    deps.logDebug(`Skipping lowest-price hourly trigger at ${hourKey}: ${currentPriceResult.reason}`);
    return;
  }

  const tokens = { current_price: currentPrice };
  const state = {
    current_price: currentPrice,
    hour_key: hourKey,
    triggered_at: now.toISOString(),
  };
  const triggerCards = [
    deps.getTriggerCard('price_lowest_before'),
    deps.getTriggerCard('price_lowest_today'),
  ];
  await Promise.all(triggerCards.map((card) => card.trigger?.(tokens, state)));
  deps.logDebug(
    `Triggered lowest-price flow cards for ${hourKey} (current_price=${currentPrice.toFixed(6)})`,
  );
};

export const startPriceLowestTriggerChecker = (deps: PriceLowestTriggerCheckerDeps): (() => void) => {
  let lastTriggeredHourKey = getCurrentLocalHourKey(deps.getNow(), deps.getTimeZone());
  const interval = setInterval(() => {
    const now = deps.getNow();
    const timeZone = deps.getTimeZone();
    const hourKey = getCurrentLocalHourKey(now, timeZone);
    if (!hourKey || hourKey === lastTriggeredHourKey) return;
    lastTriggeredHourKey = hourKey;
    triggerLowestPriceCards({ deps, now, timeZone, hourKey })
      .catch((error: unknown) => deps.error('Failed to run lowest-price trigger checker', normalizeError(error)));
  }, PRICE_LOWEST_TRIGGER_CHECK_INTERVAL_MS);

  return () => {
    clearInterval(interval);
  };
};
