import { readPelsHost } from '../../lib/app/pelsHost';
import { appNotReadyError } from '../../lib/app/settingsUiReadiness';
import type { PriceSetupSuggestion } from '../../packages/contracts/src/settingsUi/prices';
import {
  getSettingsUiPricesPayload,
  refreshSettingsUiGridTariff,
  refreshSettingsUiPrices,
} from '../settingsUiApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const pricesRoutes = defineRoutes({
  ui_prices: ({ homey }: ApiContext) => getSettingsUiPricesPayload({ homey }),
  ui_refresh_prices: ({ homey }: ApiContext) => refreshSettingsUiPrices({ homey }),
  ui_refresh_grid_tariff: ({ homey }: ApiContext) => refreshSettingsUiGridTariff({ homey }),
  // The Norway price settings for the hub's location. Asked only when the owner
  // opens Electricity prices with a setting still missing: the lookup sends the
  // hub's coordinates to NVE and Kartverket. While PELS is starting it answers
  // the settings UI's starting error rather than `none`, which would say there
  // is nothing to suggest.
  ui_price_setup_suggestion: (
    { homey }: ApiContext,
  ): Promise<PriceSetupSuggestion> => {
    const host = readPelsHost(homey);
    if (!host) throw appNotReadyError('Price setup suggestion');
    return host.suggestPriceSetup();
  },
});
