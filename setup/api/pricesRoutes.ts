import { readPelsHost } from '../../lib/app/pelsHost';
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
  // hub's coordinates to NVE and Kartverket. Never throws: no app answers `none`.
  ui_price_setup_suggestion: async ({ homey }: ApiContext): Promise<PriceSetupSuggestion> => {
    const host = readPelsHost(homey);
    return host
      ? host.suggestPriceSetup()
      : { gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'none' } };
  },
});
