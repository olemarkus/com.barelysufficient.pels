import './materialWeb.ts';
import {
  callApi,
  getApiReadModel,
  getHomeyTimezone,
  getSetting,
  primeApiCache,
  setSetting,
} from './homey.ts';
import { showToast, showToastError } from './toast.ts';
import { logSettingsError } from './logging.ts';
import { state, defaultPriceOptimizationConfig } from './state.ts';
import { supportsTemperatureDevice } from './deviceUtils.ts';
import { resolveManagedState } from './state.ts';
import { gridCompanies } from './gridCompanies.ts';
import {
  readCurrentPriceSettings,
  resolveChangedPriceSettingWrites,
  parsePriceSettingsInputs,
  normalizeNorwayPriceModel,
  normalizePriceSchemeSetting,
} from './priceSettingsPersistence.ts';
import { pushSettingWriteIfChanged } from './settingWrites.ts';
import {
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_SCHEME,
} from '../../../contracts/src/settingsKeys.ts';
import {
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  SETTINGS_UI_REFRESH_PRICES_PATH,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  getFlowPricePayload,
  getExpectedFlowHours,
  buildFlowDaySlots,
  getMissingFlowHours,
} from '../../../shared-domain/src/price/flowPriceUtils.ts';
import { getDateKeyInTimeZone, shiftDateKey } from './timezone.ts';
import { getTimeAgo } from './utils.ts';
import {
  renderElectricityPricesView,
  type ElectricityPricesViewProps,
} from './views/ElectricityPricesView.tsx';
import {
  renderPriceAwareDevicesView,
  type PriceAwareDevicesViewProps,
} from './views/PriceAwareDevicesView.tsx';
import { getCurrentSettingsUiVariant } from './uiVariant.ts';
import type {
  FlowStatus,
  HomeyStatus,
  PriceOptDevice,
  GridCompanyOption,
  PriceScheme,
  NorwayPriceModel,
} from './priceConfigTypes.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';

type PriceConfigState = {
  optimizationEnabled: boolean;
  thresholdPercent: number;
  minDiffOre: number;
  priceScheme: PriceScheme;
  norwayPriceModel: NorwayPriceModel;
  priceArea: string;
  providerSurcharge: number;
  countyCode: string;
  organizationNumber: string;
  tariffGroup: string;
  flowStatus: FlowStatus | null;
  homeyStatus: HomeyStatus | null;
};

let configState: PriceConfigState = {
  optimizationEnabled: true,
  thresholdPercent: 25,
  minDiffOre: 0,
  priceScheme: 'norway',
  norwayPriceModel: 'stromstotte',
  priceArea: 'NO1',
  providerSurcharge: 0,
  countyCode: '03',
  organizationNumber: '',
  tariffGroup: 'Husholdning',
  flowStatus: null,
  homeyStatus: null,
};

let electricityPricesSurface: HTMLElement | null = null;
let priceAwareDevicesSurface: HTMLElement | null = null;
let settingsLoaded = false;

const getGridCompanyOptions = (countyCode: string): GridCompanyOption[] => (
  gridCompanies
    .filter((c) => c.countyCodes.includes(countyCode))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ name: c.name, organizationNumber: c.organizationNumber }))
);

const buildPriceOptDevices = (devices: TargetDeviceSnapshot[]): PriceOptDevice[] => (
  devices
    .filter((d) => {
      const cfg = state.priceOptimizationSettings[d.id];
      return resolveManagedState(d.id) && cfg?.enabled === true && supportsTemperatureDevice(d);
    })
    .map((d) => {
      const cfg = state.priceOptimizationSettings[d.id] || { ...defaultPriceOptimizationConfig };
      return { id: d.id, name: d.name, cheapDelta: cfg.cheapDelta, expensiveDelta: cfg.expensiveDelta };
    })
);

type FlowStatusTone = 'ok' | 'warn';

const getFlowPayloadStatus = (
  payload: ReturnType<typeof getFlowPricePayload> | null,
  expectedDateKey: string,
  timeZone: string,
): { text: string; tone: FlowStatusTone } => {
  if (!payload) return { text: 'No data received', tone: 'warn' };

  const expectedHours = getExpectedFlowHours(payload.dateKey, timeZone);
  const expectedSlots = buildFlowDaySlots(payload.dateKey, timeZone);
  const hasExactSlots = Array.isArray(payload.pricesBySlot) && payload.pricesBySlot.length > 0;

  const storedCount = hasExactSlots
    ? (payload.pricesBySlot?.length ?? 0)
    : Object.keys(payload.pricesByHour).length;
  const expectedCount = hasExactSlots ? expectedSlots.length : expectedHours.length;
  const missingCount = hasExactSlots
    ? Math.max(0, expectedSlots.length - storedCount)
    : getMissingFlowHours(payload.pricesByHour, expectedHours).length;
  const unitLabel = hasExactSlots ? 'slots' : 'hours';

  const updatedAt = new Date(payload.updatedAt);
  const updatedText = Number.isNaN(updatedAt.getTime())
    ? 'updated time unknown'
    : `updated ${getTimeAgo(updatedAt, new Date(), timeZone)}`;
  const dateMismatch = payload.dateKey !== expectedDateKey;
  const missingSuffix = missingCount > 0 ? ` (${missingCount} missing)` : '';
  const dateSuffix = dateMismatch ? ` (payload ${payload.dateKey})` : '';

  return {
    text: `${storedCount}/${expectedCount} ${unitLabel}${missingSuffix}, ${updatedText}${dateSuffix}`,
    tone: dateMismatch || missingCount > 0 ? 'warn' : 'ok',
  };
};

const buildFlowStatus = (pricesPayload: SettingsUiPricesPayload): FlowStatus => {
  const timeZone = getHomeyTimezone();
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const todayStatus = getFlowPayloadStatus(getFlowPricePayload(pricesPayload.flowToday), todayKey, timeZone);
  const tomorrowStatus = getFlowPayloadStatus(getFlowPricePayload(pricesPayload.flowTomorrow), tomorrowKey, timeZone);
  return { today: todayStatus, tomorrow: tomorrowStatus };
};

const buildHomeyStatus = (pricesPayload: SettingsUiPricesPayload): HomeyStatus => {
  const timeZone = getHomeyTimezone();
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const currency = pricesPayload.homeyCurrency || 'Unknown';
  const todayStatus = getFlowPayloadStatus(getFlowPricePayload(pricesPayload.homeyToday), todayKey, timeZone);
  const tomorrowStatus = getFlowPayloadStatus(getFlowPricePayload(pricesPayload.homeyTomorrow), tomorrowKey, timeZone);
  return {
    currency,
    currencyTone: currency === 'Unknown' ? 'warn' : 'ok',
    today: todayStatus,
    tomorrow: tomorrowStatus,
  };
};

const renderElectricityPrices = () => {
  if (!electricityPricesSurface) return;
  const props: ElectricityPricesViewProps = {
    thresholdPercent: configState.thresholdPercent,
    minDiffOre: configState.minDiffOre,
    priceScheme: configState.priceScheme,
    norwayPriceModel: configState.norwayPriceModel,
    priceArea: configState.priceArea,
    providerSurcharge: configState.providerSurcharge,
    countyCode: configState.countyCode,
    organizationNumber: configState.organizationNumber,
    tariffGroup: configState.tariffGroup,
    flowStatus: configState.flowStatus,
    homeyStatus: configState.homeyStatus,
    gridCompanyOptions: getGridCompanyOptions(configState.countyCode),
    showPriceAwareDevicesLink: getCurrentSettingsUiVariant() !== 'redesign',
    onSchemeChange: handleSchemeChange,
    onNorwayModelChange: handleNorwayModelChange,
    onPriceAreaChange: handlePriceAreaChange,
    onProviderSurchargeChange: handleProviderSurchargeChange,
    onThresholdChange: handleThresholdChange,
    onMinDiffChange: handleMinDiffChange,
    onCountyChange: handleCountyChange,
    onOrganizationChange: handleOrganizationChange,
    onTariffGroupChange: handleTariffGroupChange,
    onRefreshPrices: handleRefreshPrices,
    onRefreshGridTariff: handleRefreshGridTariff,
  };
  renderElectricityPricesView(electricityPricesSurface, props);
};

const renderPriceAwareDevices = () => {
  if (!priceAwareDevicesSurface) return;
  const props: PriceAwareDevicesViewProps = {
    optimizationEnabled: configState.optimizationEnabled,
    devices: buildPriceOptDevices(state.latestDevices),
    onOptimizationToggle: handleOptimizationToggle,
    onDeviceCheapDeltaChange: handleDeviceCheapDeltaChange,
    onDeviceExpensiveDeltaChange: handleDeviceExpensiveDeltaChange,
  };
  renderPriceAwareDevicesView(priceAwareDevicesSurface, props);
};

const renderAll = () => {
  renderElectricityPrices();
  renderPriceAwareDevices();
};

const validateAndSavePriceSettings = async () => {
  const { priceScheme, norwayPriceModel, priceArea, providerSurcharge, thresholdPercent, minDiffOre } = configState;

  if (priceScheme === 'norway') {
    const validAreas = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'];
    if (!validAreas.includes(priceArea)) throw new Error('Invalid price area.');
    if (providerSurcharge < -100 || providerSurcharge > 100) {
      throw new Error('Provider surcharge must be between -100 and 100 øre.');
    }
  }
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
    throw new Error('Threshold must be between 0 and 100%.');
  }
  if (!Number.isFinite(minDiffOre) || minDiffOre < 0 || minDiffOre > 1000) {
    throw new Error('Minimum difference must be between 0 and 1000.');
  }

  const nextSettings = parsePriceSettingsInputs({
    priceSchemeValue: priceScheme,
    norwayPriceModelValue: norwayPriceModel,
    priceAreaValue: priceArea,
    providerSurchargeValue: String(providerSurcharge),
    thresholdPercentValue: String(thresholdPercent),
    minDiffOreValue: String(minDiffOre),
  });

  const currentSettings = await readCurrentPriceSettings();
  const writes = resolveChangedPriceSettingWrites(nextSettings, currentSettings);
  for (const write of writes) {
    await setSetting(write.key, write.value);
  }
};

const handleOptimizationToggle = async (enabled: boolean) => {
  configState = { ...configState, optimizationEnabled: enabled };
  renderAll();
  try {
    await setSetting(PRICE_OPTIMIZATION_ENABLED, enabled);
    await showToast(enabled ? 'Price optimization enabled.' : 'Price optimization disabled.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to update price optimization', error, 'priceConfig');
    await showToastError(error, 'Failed to update price optimization setting.');
  }
};

const handleSchemeChange = async (scheme: PriceScheme) => {
  configState = { ...configState, priceScheme: scheme };
  renderAll();
  try {
    await validateAndSavePriceSettings();
    await refreshStatusInfo();
    renderAll();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save price scheme', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings.');
  }
};

const handleNorwayModelChange = async (model: NorwayPriceModel) => {
  configState = { ...configState, norwayPriceModel: model };
  renderAll();
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save Norway price model', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings.');
  }
};

const handlePriceAreaChange = async (area: string) => {
  configState = { ...configState, priceArea: area };
  renderAll();
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save price area', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings.');
  }
};

const handleProviderSurchargeChange = async (val: number) => {
  configState = { ...configState, providerSurcharge: val };
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save provider surcharge', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings.');
  }
};

const handleThresholdChange = async (val: number) => {
  configState = { ...configState, thresholdPercent: val };
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save price threshold', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings.');
  }
};

const handleMinDiffChange = async (val: number) => {
  configState = { ...configState, minDiffOre: val };
  try {
    await validateAndSavePriceSettings();
    await showToast('Price settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save min diff', error, 'priceConfig');
    await showToastError(error, 'Failed to save price settings.');
  }
};

const handleCountyChange = async (code: string) => {
  configState = { ...configState, countyCode: code, organizationNumber: '' };
  renderAll();
  try {
    await setSetting('nettleie_fylke', code);
  } catch (error) {
    await logSettingsError('Failed to save county', error, 'priceConfig');
    await showToastError(error, 'Failed to save grid tariff settings.');
  }
};

const handleOrganizationChange = async (orgNumber: string) => {
  configState = { ...configState, organizationNumber: orgNumber };
  try {
    const [currentCounty, currentOrg, currentGroup] = await Promise.all([
      getSetting('nettleie_fylke'),
      getSetting('nettleie_orgnr'),
      getSetting('nettleie_tariffgruppe'),
    ]);
    const writes: Array<Promise<void>> = [];
    pushSettingWriteIfChanged(writes, 'nettleie_fylke', currentCounty, configState.countyCode);
    pushSettingWriteIfChanged(writes, 'nettleie_orgnr', currentOrg, orgNumber);
    pushSettingWriteIfChanged(writes, 'nettleie_tariffgruppe', currentGroup, configState.tariffGroup);
    if (writes.length > 0) {
      await Promise.all(writes);
      const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
      primeApiCache(SETTINGS_UI_PRICES_PATH, response ?? null);
    }
    await showToast('Grid tariff settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save organization', error, 'priceConfig');
    await showToastError(error, 'Failed to save grid tariff settings.');
  }
};

const handleTariffGroupChange = async (group: string) => {
  configState = { ...configState, tariffGroup: group };
  try {
    await setSetting('nettleie_tariffgruppe', group);
    await showToast('Grid tariff settings saved.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to save tariff group', error, 'priceConfig');
    await showToastError(error, 'Failed to save grid tariff settings.');
  }
};

const handleDeviceCheapDeltaChange = async (deviceId: string, val: number) => {
  const existing = state.priceOptimizationSettings[deviceId] || { ...defaultPriceOptimizationConfig };
  state.priceOptimizationSettings[deviceId] = { ...existing, cheapDelta: val };
  renderPriceAwareDevices();
  try {
    await setSetting('price_optimization_settings', state.priceOptimizationSettings);
  } catch (error) {
    await logSettingsError('Failed to save cheap delta', error, 'priceConfig');
    await showToastError(error, 'Failed to save price optimization setting.');
  }
};

const handleDeviceExpensiveDeltaChange = async (deviceId: string, val: number) => {
  const existing = state.priceOptimizationSettings[deviceId] || { ...defaultPriceOptimizationConfig };
  state.priceOptimizationSettings[deviceId] = { ...existing, expensiveDelta: val };
  renderPriceAwareDevices();
  try {
    await setSetting('price_optimization_settings', state.priceOptimizationSettings);
  } catch (error) {
    await logSettingsError('Failed to save expensive delta', error, 'priceConfig');
    await showToastError(error, 'Failed to save price optimization setting.');
  }
};

const handleRefreshPrices = async () => {
  try {
    const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_PRICES_PATH, {});
    primeApiCache(SETTINGS_UI_PRICES_PATH, response);
    await refreshStatusInfo();
    renderAll();
  } catch (error) {
    await logSettingsError('Failed to refresh prices', error, 'priceConfig');
    await showToastError(error, 'Failed to refresh spot prices.');
  }
};

const handleRefreshGridTariff = async () => {
  try {
    const response = await callApi<SettingsUiPricesPayload>('POST', SETTINGS_UI_REFRESH_GRID_TARIFF_PATH, {});
    primeApiCache(SETTINGS_UI_PRICES_PATH, response ?? null);
    await showToast('Grid tariffs refreshed.', 'ok');
  } catch (error) {
    await logSettingsError('Failed to refresh grid tariff', error, 'priceConfig');
    await showToastError(error, 'Failed to refresh grid tariffs.');
  }
};

const refreshStatusInfo = async () => {
  try {
    const pricesPayload = await getApiReadModel<SettingsUiPricesPayload>(SETTINGS_UI_PRICES_PATH);
    const payload = pricesPayload ?? {
      combinedPrices: null, electricityPrices: null, priceArea: null, gridTariffData: null,
      flowToday: null, flowTomorrow: null, homeyCurrency: null, homeyToday: null, homeyTomorrow: null,
    };
    configState = {
      ...configState,
      flowStatus: configState.priceScheme === 'flow' ? buildFlowStatus(payload) : null,
      homeyStatus: configState.priceScheme === 'homey' ? buildHomeyStatus(payload) : null,
    };
  } catch (error) {
    await logSettingsError('Failed to refresh price status', error, 'priceConfig');
  }
};

const stringSetting = (value: unknown, fallback: string): string => (
  typeof value === 'string' && value ? value : fallback
);

const stringSettingOrEmpty = (value: unknown): string => (
  typeof value === 'string' ? value : ''
);

const numberSetting = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const loadPriceConfigSettings = async () => {
  const [
    priceScheme,
    norwayPriceModel,
    priceArea,
    providerSurcharge,
    thresholdPercent,
    minDiffOre,
    priceOptEnabled,
    countyCode,
    organizationNumber,
    tariffGroup,
    priceOptSettings,
  ] = await Promise.all([
    getSetting(PRICE_SCHEME),
    getSetting('norway_price_model'),
    getSetting('price_area'),
    getSetting('provider_surcharge'),
    getSetting('price_threshold_percent'),
    getSetting('price_min_diff_ore'),
    getSetting(PRICE_OPTIMIZATION_ENABLED),
    getSetting('nettleie_fylke'),
    getSetting('nettleie_orgnr'),
    getSetting('nettleie_tariffgruppe'),
    getSetting('price_optimization_settings'),
  ]);

  if (priceOptSettings && typeof priceOptSettings === 'object') {
    state.priceOptimizationSettings = priceOptSettings as typeof state.priceOptimizationSettings;
  }

  configState = {
    ...configState,
    optimizationEnabled: priceOptEnabled !== false,
    priceScheme: normalizePriceSchemeSetting(priceScheme),
    norwayPriceModel: normalizeNorwayPriceModel(norwayPriceModel),
    priceArea: stringSetting(priceArea, 'NO1'),
    providerSurcharge: numberSetting(providerSurcharge, 0),
    thresholdPercent: numberSetting(thresholdPercent, 25),
    minDiffOre: numberSetting(minDiffOre, 0),
    countyCode: stringSetting(countyCode, '03'),
    organizationNumber: stringSettingOrEmpty(organizationNumber),
    tariffGroup: stringSetting(tariffGroup, 'Husholdning'),
  };
  settingsLoaded = true;
};

const ensureLoaded = async () => {
  if (!settingsLoaded) await loadPriceConfigSettings();
};

export const updatePriceConfigDevices = (devices: TargetDeviceSnapshot[]) => {
  state.latestDevices = devices;
  renderPriceAwareDevices();
};

export const refreshPriceConfigView = async () => {
  await refreshStatusInfo();
  renderAll();
};

export const reloadPriceConfigSettings = async () => {
  await loadPriceConfigSettings();
  renderAll();
};

export const initElectricityPricesView = async (surface: HTMLElement) => {
  electricityPricesSurface = surface;
  await ensureLoaded();
  await refreshStatusInfo();
  renderElectricityPrices();
};

export const initPriceAwareDevicesView = async (surface: HTMLElement) => {
  priceAwareDevicesSurface = surface;
  await ensureLoaded();
  renderPriceAwareDevices();
};
