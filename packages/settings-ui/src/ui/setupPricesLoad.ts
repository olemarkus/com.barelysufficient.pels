import {
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_PRICE_SHAPING_ENABLED,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import {
  readDailyBudgetEnabledSetting,
  readDailyBudgetPriceShapingSetting,
} from '../../../shared-domain/src/settings/dailyBudgetSettings.ts';
import { getSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { getPricesReadModel } from './prices.ts';
import { resolvePriceSetupStatus } from './priceSetupStatus.ts';
import { publishSetupPrices, publishSetupPricesUnavailable } from './setupPathFacts.ts';

let loadGeneration = 0;

/**
 * Read what the setup path's Prices step decides by, and publish it. Run again
 * whenever a price setting, Respond to prices or the daily budget changes.
 */
export const loadSetupPrices = async (): Promise<void> => {
  loadGeneration += 1;
  const generation = loadGeneration;
  try {
    const [payload, budgetEnabled, priceShaping] = await Promise.all([
      getPricesReadModel(),
      getSetting(DAILY_BUDGET_ENABLED),
      getSetting(DAILY_BUDGET_PRICE_SHAPING_ENABLED),
    ]);
    if (generation !== loadGeneration) return;
    const optimization = payload.priceOptimizationSetup;
    const status = resolvePriceSetupStatus(payload);
    // A read that cannot say keeps the last one that could.
    if (optimization.state !== 'resolved' || status.state === 'unavailable') {
      publishSetupPricesUnavailable();
      return;
    }
    publishSetupPrices({
      respondToPrices: optimization.setup.enabled,
      budgetShapesByPrice: readDailyBudgetEnabledSetting(budgetEnabled)
        && readDailyBudgetPriceShapingSetting(priceShaping),
      status,
    });
  } catch (error) {
    await logSettingsError('Failed to read prices for the setup path', error, 'setup path');
    if (generation === loadGeneration) publishSetupPricesUnavailable();
  }
};
