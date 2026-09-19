import {
  SETTINGS_UI_PRICES_PATH,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { getApiReadModel } from './homey.ts';

const EMPTY_PRICES_PAYLOAD: SettingsUiPricesPayload = {
  combinedPrices: null,
  electricityPrices: null,
  priceArea: null,
  gridTariffData: null,
  flowToday: null,
  flowTomorrow: null,
  homeyCurrency: null,
  homeyToday: null,
  homeyTomorrow: null,
  pvForecastSource: { kind: 'unknown' },
  homeyPriceFormula: { kind: 'unknown' },
};

/**
 * The payload crosses the Homey API bridge, so this is the seam that decides
 * what a missing member means — once, here, rather than at each reader. An app
 * that has not been restarted since this field was added simply does not send
 * it, and `unknown` is the union's own member for "nothing to report".
 */
export const getPricesReadModel = async (): Promise<SettingsUiPricesPayload> => {
  const payload = await getApiReadModel<SettingsUiPricesPayload>(SETTINGS_UI_PRICES_PATH);
  if (!payload) return EMPTY_PRICES_PAYLOAD;
  return payload.homeyPriceFormula
    ? payload
    : { ...payload, homeyPriceFormula: EMPTY_PRICES_PAYLOAD.homeyPriceFormula };
};
