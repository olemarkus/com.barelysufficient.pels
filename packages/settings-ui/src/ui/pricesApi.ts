import {
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi';
import {
  callApi,
  getApiReadModel,
  getSetting,
  primeApiCache,
} from './homey';
import { logSettingsError } from './logging';
import {
  isSettingsUiNetworkFailureLogged,
  withSettingsUiNetworkFailureTracking,
} from './logging';
import {
  gridTariffCompanySelect,
  gridTariffCountySelect,
  gridTariffGroupSelect,
  gridTariffOrgNumberInput,
} from './dom';
import { pushSettingWriteIfChanged } from './settingWrites';
import { showToast } from './toast';

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
  const payload = await withSettingsUiNetworkFailureTracking(
    {
      component: 'settings-ui',
      event: 'read_model',
      endpoint: SETTINGS_UI_PRICES_PATH,
      refreshLoop: 'getPricesReadModel',
      message: 'Failed to load prices',
    },
    async () => getApiReadModel<SettingsUiPricesPayload>(SETTINGS_UI_PRICES_PATH),
  );
  return payload ?? EMPTY_PRICES_PAYLOAD;
};

export const refreshGridTariff = async () => {
  try {
    await getPricesReadModel();
  } catch (error) {
    if (!isSettingsUiNetworkFailureLogged(error)) {
      await logSettingsError('Failed to load grid tariff data', error, 'refreshGridTariff');
    }
  }
};

export const saveGridTariffSettings = async () => {
  const countyCode = gridTariffCountySelect?.value || '03';
  const organizationNumber = gridTariffCompanySelect?.value || '';
  const tariffGroup = gridTariffGroupSelect?.value || 'Husholdning';

  if (gridTariffOrgNumberInput) gridTariffOrgNumberInput.value = organizationNumber;

  const [currentCountyCode, currentOrganizationNumber, currentTariffGroup] = await Promise.all([
    getSetting('nettleie_fylke'),
    getSetting('nettleie_orgnr'),
    getSetting('nettleie_tariffgruppe'),
  ]);

  const writes: Array<Promise<void>> = [];
  pushSettingWriteIfChanged(writes, 'nettleie_fylke', currentCountyCode, countyCode);
  pushSettingWriteIfChanged(writes, 'nettleie_orgnr', currentOrganizationNumber, organizationNumber);
  pushSettingWriteIfChanged(writes, 'nettleie_tariffgruppe', currentTariffGroup, tariffGroup);
  if (writes.length > 0) {
    await Promise.all(writes);
    const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
    primeApiCache(SETTINGS_UI_PRICES_PATH, response ?? EMPTY_PRICES_PAYLOAD);
    await refreshGridTariff();
  }
  await showToast('Grid tariff settings saved.', 'ok');
};
