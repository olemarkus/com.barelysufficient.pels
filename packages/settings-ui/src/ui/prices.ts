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
};

export const getPricesReadModel = async (): Promise<SettingsUiPricesPayload> => {
  const payload = await getApiReadModel<SettingsUiPricesPayload>(SETTINGS_UI_PRICES_PATH);
  return payload ?? EMPTY_PRICES_PAYLOAD;
};
