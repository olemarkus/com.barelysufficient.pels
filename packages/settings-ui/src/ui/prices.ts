import {
  priceAreaSelect,
  priceSchemeSelect,
  priceSchemeNote,
  priceNorwaySettings,
  norwayPriceModelSelect,
  providerSurchargeInput,
  norgesprisRulesRow,
  priceThresholdInput,
  priceMinDiffLabel,
  priceMinDiffInput,
  priceRefreshButton,
  priceOptimizationEnabledCheckbox,
  gridTariffCountySelect,
  gridTariffCompanySelect,
  gridTariffOrgNumberInput,
  gridTariffGroupSelect,
  priceStatusBadge,
  priceFlowStatus,
  priceFlowEnabled,
  priceFlowToday,
  priceFlowTomorrow,
  priceHomeyStatus,
  priceHomeyEnabled,
  priceHomeyCurrency,
  priceHomeyToday,
  priceHomeyTomorrow,
} from './dom';
import {
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_REFRESH_GRID_TARIFF_PATH,
  type SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi';
import { callApi, getApiReadModel, getHomeyTimezone, getSetting, primeApiCache, setSetting } from './homey';
import { pushSettingWriteIfChanged } from './settingWrites';
import { showToast } from './toast';
import { gridCompanies } from './gridCompanies';
import { renderPrices } from './priceRender';
import type { CombinedPriceData, PriceEntry } from './priceTypes';
import { logSettingsError } from './logging';
import { getVatMultiplier } from '../../../shared-domain/src/price/priceComponents';
import {
  NORWAY_PRICE_MODEL,
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_SCHEME,
} from '../../../contracts/src/settingsKeys';
import {
  buildFlowDaySlots,
  getExpectedFlowHours,
  getFlowPricePayload,
  getMissingFlowHours,
} from '../../../shared-domain/src/price/flowPriceUtils';
import { getTimeAgo } from './utils';
import { applyPriceOverrides, type PriceOverrideOptions } from './priceOverrides';
import { getDateKeyInTimeZone, shiftDateKey } from './timezone';

import {
  normalizeNorwayPriceModel,
  normalizePriceSchemeSelection,
  normalizePriceSchemeSetting,
  parsePriceSettingsInputs,
  readCurrentPriceSettings,
  resolveChangedPriceSettingWrites,
  type NorwayPriceModel,
  type PriceScheme,
} from './priceSettingsPersistence';

type GridTariffEntry = {
  time: number;
  energyFeeExVat?: number | null;
  energyFeeIncVat?: number | null;
  fixedFeeExVat?: number | null;
  fixedFeeIncVat?: number | null;
  dateKey?: string;
  energileddEks?: number | null;
  energileddInk?: number | null;
  fastleddEks?: number | null;
  fastleddInk?: number | null;
  datoId?: string;
};

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

const setNorwayPriceControlsDisabled = (disabled: boolean) => {
  if (priceNorwaySettings) priceNorwaySettings.hidden = disabled;
  if (norwayPriceModelSelect) norwayPriceModelSelect.disabled = disabled;
  if (priceAreaSelect) priceAreaSelect.disabled = disabled;
  if (providerSurchargeInput) providerSurchargeInput.disabled = disabled;
  if (gridTariffCountySelect) gridTariffCountySelect.disabled = disabled;
  if (gridTariffCompanySelect) gridTariffCompanySelect.disabled = disabled;
  if (gridTariffGroupSelect) gridTariffGroupSelect.disabled = disabled;
};

const setNorgesprisVisibility = (show: boolean) => {
  if (!norgesprisRulesRow) return;
  norgesprisRulesRow.hidden = !show;
  norgesprisRulesRow.setAttribute('aria-hidden', show ? 'false' : 'true');
  norgesprisRulesRow.style.display = show ? '' : 'none';
};

const setRefreshButtonState = (isFlow: boolean, isHomey: boolean) => {
  if (!priceRefreshButton) return;
  priceRefreshButton.disabled = isFlow;
  priceRefreshButton.hidden = isFlow;
  priceRefreshButton.textContent = 'Refresh prices';
  priceRefreshButton.title = isHomey
    ? 'Refresh Homey Energy prices.'
    : 'Refresh Norwegian spot prices.';
};

const setPriceSchemeNote = (scheme: PriceScheme) => {
  if (!priceSchemeNote) return;
  if (scheme === 'flow') {
    priceSchemeNote.textContent = 'Flow source uses values as provided (currency/tax may vary). '
      + 'Use this outside Norway or when you prefer external prices. Make sure you feed today and '
      + 'tomorrow prices into the PELS flow actions.';
    priceSchemeNote.hidden = false;
    return;
  }
  if (scheme === 'homey') {
    priceSchemeNote.textContent = 'Homey Energy uses values as provided (currency/tax may vary). '
      + 'Prices are read from your Homey Energy settings and used directly.';
    priceSchemeNote.hidden = false;
    return;
  }
  priceSchemeNote.hidden = true;
};

const setSchemeStatusVisibility = (isFlow: boolean, isHomey: boolean) => {
  if (priceFlowStatus) priceFlowStatus.hidden = !isFlow;
  if (priceHomeyStatus) priceHomeyStatus.hidden = !isHomey;
};

const setMinDiffLabel = (isExternal: boolean) => {
  if (!priceMinDiffLabel) return;
  priceMinDiffLabel.textContent = isExternal
    ? 'Minimum price difference'
    : 'Minimum price difference (øre/kWh)';
};

const applyPriceSchemeUi = (scheme: PriceScheme, norwayModel: NorwayPriceModel) => {
  const isFlow = scheme === 'flow';
  const isHomey = scheme === 'homey';
  const isExternal = isFlow || isHomey;
  setNorwayPriceControlsDisabled(isExternal);
  setNorgesprisVisibility(!isExternal && norwayModel === 'norgespris');
  setRefreshButtonState(isFlow, isHomey);
  setPriceSchemeNote(scheme);
  setSchemeStatusVisibility(isFlow, isHomey);
  setMinDiffLabel(isExternal);
};

export const updatePriceSchemeUiFromSelection = () => {
  const scheme = normalizePriceSchemeSelection(priceSchemeSelect?.value || 'homey');
  const norwayModel = normalizeNorwayPriceModel(norwayPriceModelSelect?.value || 'stromstotte');
  applyPriceSchemeUi(scheme, norwayModel);
};

export const loadPriceSettings = async () => {
  const priceScheme = normalizePriceSchemeSelection(await getSetting(PRICE_SCHEME));
  const norwayPriceModel = normalizeNorwayPriceModel(await getSetting(NORWAY_PRICE_MODEL));
  const priceArea = await getSetting('price_area');
  const providerSurcharge = await getSetting('provider_surcharge');
  const thresholdPercent = await getSetting('price_threshold_percent');
  const minDiffOre = await getSetting('price_min_diff_ore');
  const priceOptEnabled = await getSetting(PRICE_OPTIMIZATION_ENABLED);

  if (priceSchemeSelect) {
    priceSchemeSelect.value = priceScheme;
  }
  if (norwayPriceModelSelect) {
    norwayPriceModelSelect.value = norwayPriceModel;
  }
  if (priceAreaSelect) {
    priceAreaSelect.value = typeof priceArea === 'string' ? priceArea : 'NO1';
  }
  if (providerSurchargeInput) {
    providerSurchargeInput.value = typeof providerSurcharge === 'number' ? providerSurcharge.toString() : '0';
  }
  if (priceThresholdInput) {
    priceThresholdInput.value = typeof thresholdPercent === 'number' ? thresholdPercent.toString() : '25';
  }
  if (priceMinDiffInput) {
    priceMinDiffInput.value = typeof minDiffOre === 'number' ? minDiffOre.toString() : '0';
  }
  if (priceOptimizationEnabledCheckbox) {
    priceOptimizationEnabledCheckbox.checked = priceOptEnabled !== false;
  }

  applyPriceSchemeUi(priceScheme, norwayPriceModel);
  await refreshFlowStatus(priceScheme);
  await refreshHomeyStatus(priceScheme);
};

type FlowStatusTone = 'ok' | 'warn';
type FlowPayloadCoverage = {
  storedCount: number;
  expectedCount: number;
  missingCount: number;
  unitLabel: 'slots' | 'hours';
};

const updateFlowStatusValue = (target: HTMLSpanElement | null, text: string, tone: FlowStatusTone) => {
  if (!target) return;
  const el = target;
  el.textContent = text;
  el.classList.remove('ok', 'warn');
  el.classList.add(tone);
};

const getFlowPayloadCoverage = (
  payload: NonNullable<ReturnType<typeof getFlowPricePayload>>,
  timeZone: string,
): FlowPayloadCoverage => {
  const expectedHours = getExpectedFlowHours(payload.dateKey, timeZone);
  const expectedSlots = buildFlowDaySlots(payload.dateKey, timeZone);
  const hasExactSlots = Array.isArray(payload.pricesBySlot) && payload.pricesBySlot.length > 0;

  if (hasExactSlots) {
    const storedCount = payload.pricesBySlot?.length ?? 0;
    return {
      storedCount,
      expectedCount: expectedSlots.length,
      missingCount: Math.max(0, expectedSlots.length - storedCount),
      unitLabel: 'slots',
    };
  }

  return {
    storedCount: Object.keys(payload.pricesByHour).length,
    expectedCount: expectedHours.length,
    missingCount: getMissingFlowHours(payload.pricesByHour, expectedHours).length,
    unitLabel: 'hours',
  };
};

const formatFlowPayloadStatus = (
  payload: ReturnType<typeof getFlowPricePayload> | null,
  expectedDateKey: string,
  timeZone: string,
): { text: string; tone: FlowStatusTone } => {
  if (!payload) {
    return { text: 'No data received', tone: 'warn' };
  }

  const { storedCount, expectedCount, missingCount, unitLabel } = getFlowPayloadCoverage(payload, timeZone);
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

export const refreshFlowStatus = async (schemeOverride?: PriceScheme) => {
  const scheme = schemeOverride ?? normalizePriceSchemeSelection(await getSetting(PRICE_SCHEME));
  if (!priceFlowStatus || scheme !== 'flow') return;

  const timeZone = getHomeyTimezone();
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const pricePayload = await getPricesReadModel();

  updateFlowStatusValue(priceFlowEnabled, 'Enabled', 'ok');

  const todayPayload = getFlowPricePayload(pricePayload.flowToday);
  const tomorrowPayload = getFlowPricePayload(pricePayload.flowTomorrow);

  const todayStatus = formatFlowPayloadStatus(todayPayload, todayKey, timeZone);
  const tomorrowStatus = formatFlowPayloadStatus(tomorrowPayload, tomorrowKey, timeZone);

  updateFlowStatusValue(priceFlowToday, todayStatus.text, todayStatus.tone);
  updateFlowStatusValue(priceFlowTomorrow, tomorrowStatus.text, tomorrowStatus.tone);
};

export const refreshHomeyStatus = async (schemeOverride?: PriceScheme) => {
  const scheme = schemeOverride ?? normalizePriceSchemeSelection(await getSetting(PRICE_SCHEME));
  if (!priceHomeyStatus || scheme !== 'homey') return;

  const timeZone = getHomeyTimezone();
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);
  const pricePayload = await getPricesReadModel();

  updateFlowStatusValue(priceHomeyEnabled, 'Enabled', 'ok');

  const currency = pricePayload.homeyCurrency || 'Unknown';
  updateFlowStatusValue(priceHomeyCurrency, currency, currency === 'Unknown' ? 'warn' : 'ok');

  const todayPayload = getFlowPricePayload(pricePayload.homeyToday);
  const tomorrowPayload = getFlowPricePayload(pricePayload.homeyTomorrow);

  const todayStatus = formatFlowPayloadStatus(todayPayload, todayKey, timeZone);
  const tomorrowStatus = formatFlowPayloadStatus(tomorrowPayload, tomorrowKey, timeZone);

  updateFlowStatusValue(priceHomeyToday, todayStatus.text, todayStatus.tone);
  updateFlowStatusValue(priceHomeyTomorrow, tomorrowStatus.text, tomorrowStatus.tone);
};

const validatePriceArea = (priceArea: string) => {
  const validPriceAreas = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'];
  if (!validPriceAreas.includes(priceArea)) throw new Error('Invalid price area.');
};

const validateNumberRange = (value: number, min: number, max: number, message: string) => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(message);
  }
};

export const savePriceSettings = async () => {
  const nextSettings = parsePriceSettingsInputs({
    priceSchemeValue: priceSchemeSelect?.value || 'homey',
    norwayPriceModelValue: norwayPriceModelSelect?.value || 'stromstotte',
    priceAreaValue: priceAreaSelect?.value,
    providerSurchargeValue: providerSurchargeInput?.value,
    thresholdPercentValue: priceThresholdInput?.value,
    minDiffOreValue: priceMinDiffInput?.value,
  });
  const {
    priceScheme,
    norwayPriceModel,
    priceArea,
    providerSurcharge,
    thresholdPercent,
    minDiffOre,
  } = nextSettings;

  if (priceScheme === 'norway') {
    validatePriceArea(priceArea);
    if (norwayPriceModel !== 'stromstotte' && norwayPriceModel !== 'norgespris') {
      throw new Error('Invalid Norway pricing model.');
    }
    validateNumberRange(providerSurcharge, -100, 1000, 'Provider surcharge must be between -100 and 1000 øre.');
  }
  validateNumberRange(thresholdPercent, 0, 100, 'Threshold must be between 0 and 100%.');
  validateNumberRange(minDiffOre, 0, 1000, 'Minimum difference must be between 0 and 1000.');

  const currentSettings = await readCurrentPriceSettings();
  const writes = resolveChangedPriceSettingWrites(nextSettings, currentSettings);
  if (writes.length > 0) {
    for (const write of writes) {
      await setSetting(write.key, write.value);
    }
  }
  applyPriceSchemeUi(priceScheme, norwayPriceModel);
  void showToast('Price settings saved.', 'ok');
  await refreshPrices({ thresholdPercent, minDiffOre });
};

const attachSchemeMetadata = (
  data: CombinedPriceData,
  priceScheme: PriceScheme,
  priceUnit: string,
): CombinedPriceData => ({
  ...data,
  priceScheme: data.priceScheme ?? priceScheme,
  priceUnit: data.priceUnit ?? priceUnit,
});

const buildCombinedFromLegacy = (
  combinedData: unknown,
  priceScheme: PriceScheme,
  priceUnit: string,
): CombinedPriceData | null => {
  if (!combinedData || !Array.isArray(combinedData) || combinedData.length === 0) return null;
  const prices = combinedData as PriceEntry[];
  const avgPrice = prices.reduce((sum, p) => sum + p.total, 0) / prices.length;
  return {
    prices,
    avgPrice,
    lowThreshold: avgPrice * 0.75,
    highThreshold: avgPrice * 1.25,
    priceScheme,
    priceUnit,
  };
};

const buildCombinedFromSpotPrices = async (
  pricePayload: SettingsUiPricesPayload,
): Promise<CombinedPriceData | null> => {
  const priceData = pricePayload.electricityPrices;
  if (!priceData || !Array.isArray(priceData) || priceData.length === 0) return null;
  const priceArea = typeof pricePayload.priceArea === 'string' ? pricePayload.priceArea : 'NO1';
  const vatMultiplier = getVatMultiplier(priceArea);
  const prices = (priceData as Array<{ startsAt?: string; spotPriceExVat?: number; total?: number }>)
    .filter((entry) => typeof entry.startsAt === 'string')
    .map((entry) => {
      let spotPriceExVat = 0;
      if (typeof entry.spotPriceExVat === 'number') {
        spotPriceExVat = entry.spotPriceExVat;
      } else if (typeof entry.total === 'number') {
        spotPriceExVat = entry.total / vatMultiplier;
      }
      const total = spotPriceExVat * vatMultiplier;
      return {
        startsAt: entry.startsAt as string,
        total,
        spotPriceExVat,
        vatMultiplier,
        vatAmount: total - spotPriceExVat,
        totalExVat: spotPriceExVat,
      } satisfies PriceEntry;
    });
  const avgPrice = prices.reduce((sum, p) => sum + p.total, 0) / prices.length;
  return {
    prices,
    avgPrice,
    lowThreshold: avgPrice * 0.75,
    highThreshold: avgPrice * 1.25,
    priceScheme: 'norway',
    priceUnit: 'øre/kWh',
  };
};

const getPriceData = async (): Promise<CombinedPriceData | null> => {
  const priceScheme = normalizePriceSchemeSetting(await getSetting(PRICE_SCHEME));
  const pricePayload = await getPricesReadModel();
  const homeyCurrency = priceScheme === 'homey' ? (pricePayload.homeyCurrency || '') : '';
  const priceUnit = priceScheme === 'norway' ? 'øre/kWh' : (homeyCurrency || 'price units');
  const combinedData = pricePayload.combinedPrices;
  if (combinedData && typeof combinedData === 'object' && 'prices' in combinedData) {
    return attachSchemeMetadata(combinedData as CombinedPriceData, priceScheme, priceUnit);
  }
  if (priceScheme !== 'norway') return null;
  const legacy = buildCombinedFromLegacy(combinedData, priceScheme, priceUnit);
  if (legacy) return legacy;
  return buildCombinedFromSpotPrices(pricePayload);
};

export const refreshPrices = async (overrides?: PriceOverrideOptions) => {
  try {
    const prices = await getPriceData();
    const hasOverrides = overrides && (
      Number.isFinite(overrides.thresholdPercent) || Number.isFinite(overrides.minDiffOre)
    );
    renderPrices(prices && hasOverrides ? applyPriceOverrides(prices, overrides) : prices);
    await refreshFlowStatus();
    await refreshHomeyStatus();
  } catch (error) {
    await logSettingsError('Failed to load prices', error, 'refreshPrices');
    if (priceStatusBadge) {
      priceStatusBadge.textContent = 'Error';
      priceStatusBadge.classList.add('warn');
      priceStatusBadge.hidden = false;
    }
  }
};

export const updateGridCompanyOptions = (countyCode: string) => {
  if (!gridTariffCompanySelect) return;

  const currentValue = gridTariffOrgNumberInput?.value || '';
  gridTariffCompanySelect.innerHTML = '<option value="">-- Select grid company --</option>';

  const filteredCompanies = gridCompanies
    .filter((company) => company.countyCodes.includes(countyCode))
    .sort((a, b) => a.name.localeCompare(b.name));

  filteredCompanies.forEach((company) => {
    const opt = document.createElement('option');
    opt.value = company.organizationNumber;
    opt.textContent = company.name;
    if (company.organizationNumber === currentValue) opt.selected = true;
    gridTariffCompanySelect.appendChild(opt);
  });
};

export const loadGridTariffSettings = async () => {
  const countyCode = await getSetting('nettleie_fylke');
  const organizationNumber = await getSetting('nettleie_orgnr');
  const tariffGroup = await getSetting('nettleie_tariffgruppe');

  if (gridTariffCountySelect && typeof countyCode === 'string') {
    gridTariffCountySelect.value = countyCode;
  }

  updateGridCompanyOptions(typeof countyCode === 'string' ? countyCode : '03');

  if (gridTariffOrgNumberInput && typeof organizationNumber === 'string') {
    gridTariffOrgNumberInput.value = organizationNumber;
    if (gridTariffCompanySelect) {
      gridTariffCompanySelect.value = organizationNumber;
    }
  }
  if (gridTariffGroupSelect && typeof tariffGroup === 'string') {
    gridTariffGroupSelect.value = tariffGroup;
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

const getGridTariffData = async (): Promise<GridTariffEntry[]> => {
  const data = (await getPricesReadModel()).gridTariffData;
  if (!data || !Array.isArray(data)) return [];
  return data as GridTariffEntry[];
};

export const refreshGridTariff = async () => {
  try {
    await getGridTariffData();
  } catch (error) {
    await logSettingsError('Failed to load grid tariff data', error, 'refreshGridTariff');
  }
};
