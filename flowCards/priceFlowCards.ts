import { PriceLevel, PRICE_LEVEL_OPTIONS, PriceLevelOption } from '../lib/price/priceLevels';
import { normalizeError } from '../lib/utils/errorUtils';
import { evaluateLowestPriceCard, type LowestPriceCardId } from '../lib/price/priceLowestFlowEvaluator';
import {
  readFlowRawArg,
  readFlowStringArg,
} from './flowArgParsers';
import type { FlowCardDeps } from './registerFlowCards';

export function registerPriceLevelCards(deps: FlowCardDeps): void {
  const priceLevelChangedTrigger = deps.homey.flow.getTriggerCard('price_level_changed');
  priceLevelChangedTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
    const chosenLevel = readPriceLevelArg(args);
    const statePriceLevel = readFlowStringArg(state, 'priceLevel');
    const stateLevel = (statePriceLevel.toLowerCase() || PriceLevel.UNKNOWN) as PriceLevel;
    return chosenLevel === stateLevel;
  });
  priceLevelChangedTrigger.registerArgumentAutocompleteListener('level', async (query: string) => (
    getPriceLevelOptions(query)
  ));

  const priceLevelIsCond = deps.homey.flow.getConditionCard('price_level_is');
  priceLevelIsCond.registerRunListener(async (args: unknown) => {
    const chosenLevel = readPriceLevelArg(args);
    const currentLevel = deps.getCurrentPriceLevel();
    return chosenLevel === currentLevel;
  });
  priceLevelIsCond.registerArgumentAutocompleteListener('level', async (query: string) => (
    getPriceLevelOptions(query)
  ));
}

export function registerFlowPriceCards(deps: FlowCardDeps): void {
  const setTodayCard = deps.homey.flow.getActionCard('set_external_prices_today');
  setTodayCard.registerRunListener(createPriceCardRunListener('today', deps));

  const setTomorrowCard = deps.homey.flow.getActionCard('set_external_prices_tomorrow');
  setTomorrowCard.registerRunListener(createPriceCardRunListener('tomorrow', deps));
}

function createPriceCardRunListener(kind: 'today' | 'tomorrow', deps: FlowCardDeps) {
  return async (args: unknown) => {
    try {
      const raw = readFlowRawArg(args, 'prices_json');
      if (raw === null || raw === undefined || String(raw).trim() === '') {
        throw new Error('Price data is required.');
      }
      const result = deps.storeFlowPriceData(kind, raw);
      deps.getStructuredLogger('price')?.info({
        event: 'flow_prices_stored',
        priceKind: kind,
        dateKey: result.dateKey,
        storedCount: result.storedCount,
      });
      return true;
    } catch (error) {
      const normalizedError = normalizeError(error);
      deps.getStructuredLogger('price')?.error({
        event: 'flow_prices_store_failed',
        priceKind: kind,
        error: normalizedError.message,
      });
      throw normalizedError;
    }
  };
}

export function registerLowestPriceCards(deps: FlowCardDeps): void {
  const cardIds: LowestPriceCardId[] = ['price_lowest_before', 'price_lowest_today'];

  for (const cardId of cardIds) {
    const conditionCard = deps.homey.flow.getConditionCard(cardId);
    conditionCard.registerRunListener(async (args: unknown) => (
      evaluateLowestPriceFlowCard(cardId, args, 'condition', deps)
    ));

    const triggerCard = deps.homey.flow.getTriggerCard(cardId);
    triggerCard.registerRunListener(async (args: unknown, state?: unknown) => (
      evaluateLowestPriceFlowCard(cardId, args, 'trigger', deps, state)
    ));
  }
}

function evaluateLowestPriceFlowCard(
  cardId: LowestPriceCardId,
  args: unknown,
  source: 'trigger' | 'condition',
  deps: FlowCardDeps,
  state?: unknown,
): boolean {
  const triggerState = source === 'trigger' && state && typeof state === 'object'
    ? state as Record<string, unknown>
    : null;
  const stateCurrentPriceRaw = Number(triggerState?.current_price);
  const currentPriceOverride = Number.isFinite(stateCurrentPriceRaw) ? stateCurrentPriceRaw : undefined;
  const triggeredAtRaw = triggerState?.triggered_at;
  const triggeredAt = typeof triggeredAtRaw === 'string' ? new Date(triggeredAtRaw) : null;
  const now = triggeredAt && Number.isFinite(triggeredAt.getTime()) ? triggeredAt : deps.getNow();

  const result = evaluateLowestPriceCard({
    cardId,
    args,
    combinedPrices: deps.getCombinedHourlyPrices(),
    timeZone: deps.getTimeZone(),
    now,
    currentPriceOverride,
  });

  deps.debugStructured({
    event: 'price_lowest_card_evaluated',
    source,
    cardId,
    reason: result.reason,
    currentPrice: result.currentPrice,
    stateCurrentPrice: currentPriceOverride ?? null,
    cutoff: result.cutoff,
    candidateCount: result.candidateCount,
    matches: result.matches,
  });

  return result.matches;
}

function getPriceLevelOptions(query: string): Array<{ id: string; name: string }> {
  const q = (query || '').toLowerCase();
  return PRICE_LEVEL_OPTIONS
    .filter((opt: PriceLevelOption) => !q || opt.name.toLowerCase().includes(q))
    .map((opt: PriceLevelOption) => ({ id: opt.id, name: opt.name }));
}

function readPriceLevelArg(args: unknown): PriceLevel {
  const raw = readFlowStringArg(args, 'level').toLowerCase();
  return (raw || PriceLevel.UNKNOWN) as PriceLevel;
}
