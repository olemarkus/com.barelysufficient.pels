import {
  priceAreaSelect,
  priceSchemeSelect,
  priceSchemeNote,
  priceNorwaySettings,
  providerSurchargeInput,
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
import { getHomeyTimezone, getSetting, setSetting } from './homey';
import { showToast } from './toast';
import { gridCompanies } from './gridCompanies';
import { renderPrices } from './priceRender';
import type { CombinedPriceData, PriceEntry } from './priceTypes';
import { calculateThresholds } from './priceThresholds';
import { logSettingsError } from './logging';
import { getVatMultiplier } from '../../../lib/price/priceComponents';
import { FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW, HOMEY_PRICES_CURRENCY, HOMEY_PRICES_TODAY, HOMEY_PRICES_TOMORROW, PRICE_SCHEME } from '../../../lib/utils/settingsKeys';
import { getFlowPricePayload, getMissingFlowHours } from '../../../lib/price/flowPriceUtils';
import { addDays } from '../../../lib/price/priceServiceUtils';
import { getTimeAgo } from './utils';
import { getDateKeyInTimeZone } from './timezone';

type PriceScheme = 'norway' | 'flow' | 'homey';

const normalizePriceScheme = (value: unknown): PriceScheme => {
  if (value === 'flow' || value === 'homey') return value;
  return 'norway';
};

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

const setNorwayPriceControlsDisabled = (disabled: boolean) => {
  if (priceNorwaySettings) priceNorwaySettings.hidden = disabled;
  if (priceAreaSelect) priceAreaSelect.disabled = disabled;
  if (providerSurchargeInput) providerSurchargeInput.disabled = disabled;
  if (gridTariffCountySelect) gridTariffCountySelect.disabled = disabled;
  if (gridTariffCompanySelect) gridTariffCompanySelect.disabled = disabled;
  if (gridTariffGroupSelect) gridTariffGroupSelect.disabled = disabled;
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

const applyPriceSchemeUi = (scheme: PriceScheme) => {
  const isFlow = scheme === 'flow';
  const isHomey = scheme === 'homey';
  const isExternal = isFlow || isHomey;
  setNorwayPriceControlsDisabled(isExternal);
  setRefreshButtonState(isFlow, isHomey);
  setPriceSchemeNote(scheme);
  setSchemeStatusVisibility(isFlow, isHomey);
  setMinDiffLabel(isExternal);
};

export const loadPriceSettings = async () => {
  const priceScheme = normalizePriceScheme(await getSetting(PRICE_SCHEME));
  const priceArea = await getSetting('price_area');
  const providerSurcharge = await getSetting('provider_surcharge');
  const thresholdPercent = await getSetting('price_threshold_percent');
  const minDiffOre = await getSetting('price_min_diff_ore');
  const priceOptEnabled = await getSetting('price_optimization_enabled');

  if (priceSchemeSelect) {
    priceSchemeSelect.value = priceScheme;
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

  applyPriceSchemeUi(priceScheme);
  await refreshFlowStatus(priceScheme);
  await refreshHomeyStatus(priceScheme);
};

type FlowStatusTone = 'ok' | 'warn';

const updateFlowStatusValue = (target: HTMLSpanElement | null, text: string, tone: FlowStatusTone) => {
  if (!target) return;
  const el = target;
  el.textContent = text;
  el.classList.remove('ok', 'warn');
  el.classList.add(tone);
};

const formatFlowPayloadStatus = (
  payload: ReturnType<typeof getFlowPricePayload> | null,
  expectedDateKey: string,
  timeZone: string,
): { text: string; tone: FlowStatusTone } => {
  if (!payload) {
    return { text: 'No data received', tone: 'warn' };
  }

  const hourCount = Object.keys(payload.pricesByHour).length;
  const missingHours = getMissingFlowHours(payload.pricesByHour);
  const updatedAt = new Date(payload.updatedAt);
  const updatedText = Number.isNaN(updatedAt.getTime())
    ? 'updated time unknown'
    : `updated ${getTimeAgo(updatedAt, new Date(), timeZone)}`;
  const dateMismatch = payload.dateKey !== expectedDateKey;
  const missingSuffix = missingHours.length > 0 ? ` (${missingHours.length} missing)` : '';
  const dateSuffix = dateMismatch ? ` (payload ${payload.dateKey})` : '';

  return {
    text: `${hourCount}/24 hours${missingSuffix}, ${updatedText}${dateSuffix}`,
    tone: dateMismatch || missingHours.length > 0 ? 'warn' : 'ok',
  };
};

export const refreshFlowStatus = async (schemeOverride?: PriceScheme) => {
  const scheme = schemeOverride ?? normalizePriceScheme(await getSetting(PRICE_SCHEME));
  if (!priceFlowStatus || scheme !== 'flow') return;

  const timeZone = getHomeyTimezone();
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const tomorrowKey = getDateKeyInTimeZone(addDays(new Date(), 1), timeZone);

  updateFlowStatusValue(priceFlowEnabled, 'Enabled', 'ok');

  const todayPayload = getFlowPricePayload(await getSetting(FLOW_PRICES_TODAY));
  const tomorrowPayload = getFlowPricePayload(await getSetting(FLOW_PRICES_TOMORROW));

  const todayStatus = formatFlowPayloadStatus(todayPayload, todayKey, timeZone);
  const tomorrowStatus = formatFlowPayloadStatus(tomorrowPayload, tomorrowKey, timeZone);

  updateFlowStatusValue(priceFlowToday, todayStatus.text, todayStatus.tone);
  updateFlowStatusValue(priceFlowTomorrow, tomorrowStatus.text, tomorrowStatus.tone);
};

export const refreshHomeyStatus = async (schemeOverride?: PriceScheme) => {
  const scheme = schemeOverride ?? normalizePriceScheme(await getSetting(PRICE_SCHEME));
  if (!priceHomeyStatus || scheme !== 'homey') return;

  const timeZone = getHomeyTimezone();
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const tomorrowKey = getDateKeyInTimeZone(addDays(new Date(), 1), timeZone);

  updateFlowStatusValue(priceHomeyEnabled, 'Enabled', 'ok');

  const currencySetting = await getSetting(HOMEY_PRICES_CURRENCY);
  const currency = typeof currencySetting === 'string' ? currencySetting : 'Unknown';
  updateFlowStatusValue(priceHomeyCurrency, currency, currency === 'Unknown' ? 'warn' : 'ok');

  const todayPayload = getFlowPricePayload(await getSetting(HOMEY_PRICES_TODAY));
  const tomorrowPayload = getFlowPricePayload(await getSetting(HOMEY_PRICES_TOMORROW));

  const todayStatus = formatFlowPayloadStatus(todayPayload, todayKey, timeZone);
  const tomorrowStatus = formatFlowPayloadStatus(tomorrowPayload, tomorrowKey, timeZone);

  updateFlowStatusValue(priceHomeyToday, todayStatus.text, todayStatus.tone);
  updateFlowStatusValue(priceHomeyTomorrow, tomorrowStatus.text, tomorrowStatus.tone);
};

type PriceSettingsInput = {
  priceScheme: PriceScheme;
  priceArea: string;
  providerSurcharge: number;
  thresholdPercent: number;
  minDiffOre: number;
};

type PriceOverrideOptions = {
  thresholdPercent?: number;
  minDiffOre?: number;
};

const parsePriceSettingsInputs = (): PriceSettingsInput => ({
  priceScheme: normalizePriceScheme(priceSchemeSelect?.value || 'norway'),
  priceArea: priceAreaSelect?.value || 'NO1',
  providerSurcharge: parseFloat(providerSurchargeInput?.value || '0') || 0,
  thresholdPercent: parseInt(priceThresholdInput?.value || '25', 10) || 25,
  minDiffOre: parseFloat(priceMinDiffInput?.value || '0') || 0,
});

const validatePriceArea = (priceArea: string) => {
  const validPriceAreas = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'];
  if (!validPriceAreas.includes(priceArea)) throw new Error('Invalid price area.');
};

const validateNumberRange = (value: number, min: number, max: number, message: string) => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(message);
  }
};

const resolveNumber = (value: number | undefined, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const getAveragePrice = (prices: PriceEntry[], fallback: number): number => {
  if (prices.length === 0) return fallback;
  const total = prices.reduce((sum, price) => sum + (Number.isFinite(price.total) ? price.total : 0), 0);
  return total / prices.length;
};

const applyPriceOverrides = (data: CombinedPriceData, overrides: PriceOverrideOptions): CombinedPriceData => {
  // Keep this logic aligned with priceService.updateCombinedPrices.
  const thresholdPercent = resolveNumber(overrides.thresholdPercent, data.thresholdPercent ?? 25);
  const minDiffOre = resolveNumber(overrides.minDiffOre, data.minDiffOre ?? 0);
  const avgPrice = resolveNumber(data.avgPrice, getAveragePrice(data.prices, 0));
  const { low: lowThreshold, high: highThreshold } = calculateThresholds(avgPrice, thresholdPercent);

  const prices = data.prices.map((entry) => {
    const total = Number.isFinite(entry.total) ? entry.total : 0;
    const diffFromAvg = Math.abs(total - avgPrice);
    const meetsMinDiff = diffFromAvg >= minDiffOre;
    return {
      ...entry,
      isCheap: total <= lowThreshold && meetsMinDiff,
      isExpensive: total >= highThreshold && meetsMinDiff,
    };
  });

  return {
    ...data,
    prices,
    avgPrice,
    lowThreshold,
    highThreshold,
    thresholdPercent,
    minDiffOre,
  };
};

export const savePriceSettings = async () => {
  const {
    priceScheme,
    priceArea,
    providerSurcharge,
    thresholdPercent,
    minDiffOre,
  } = parsePriceSettingsInputs();

  if (priceScheme === 'norway') {
    validatePriceArea(priceArea);
    validateNumberRange(providerSurcharge, -100, 1000, 'Provider surcharge must be between -100 and 1000 øre.');
  }
  validateNumberRange(thresholdPercent, 0, 100, 'Threshold must be between 0 and 100%.');
  validateNumberRange(minDiffOre, 0, 1000, 'Minimum difference must be between 0 and 1000.');

  await setSetting(PRICE_SCHEME, priceScheme);
  await setSetting('price_area', priceArea);
  await setSetting('provider_surcharge', providerSurcharge);
  await setSetting('price_threshold_percent', thresholdPercent);
  await setSetting('price_min_diff_ore', minDiffOre);
  applyPriceSchemeUi(priceScheme);
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

const buildCombinedFromSpotPrices = async (): Promise<CombinedPriceData | null> => {
  const priceData = await getSetting('electricity_prices');
  if (!priceData || !Array.isArray(priceData) || priceData.length === 0) return null;
  const priceAreaSetting = await getSetting('price_area');
  const priceArea = typeof priceAreaSetting === 'string' ? priceAreaSetting : 'NO1';
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
  const priceScheme = normalizePriceScheme(await getSetting(PRICE_SCHEME));
  const currencySetting = priceScheme === 'homey' ? await getSetting(HOMEY_PRICES_CURRENCY) : null;
  const homeyCurrency = typeof currencySetting === 'string' ? currencySetting : '';
  const priceUnit = priceScheme === 'norway' ? 'øre/kWh' : (homeyCurrency || 'price units');
  const combinedData = await getSetting('combined_prices');
  if (combinedData && typeof combinedData === 'object' && 'prices' in combinedData) {
    return attachSchemeMetadata(combinedData as CombinedPriceData, priceScheme, priceUnit);
  }
  if (priceScheme !== 'norway') return null;
  const legacy = buildCombinedFromLegacy(combinedData, priceScheme, priceUnit);
  if (legacy) return legacy;
  return buildCombinedFromSpotPrices();
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

  await setSetting('nettleie_fylke', countyCode);
  await setSetting('nettleie_orgnr', organizationNumber);
  await setSetting('nettleie_tariffgruppe', tariffGroup);
  await showToast('Grid tariff settings saved.', 'ok');

  await setSetting('refresh_nettleie', Date.now());
  await refreshGridTariff();
};

const getGridTariffData = async (): Promise<GridTariffEntry[]> => {
  const data = await getSetting('nettleie_data');
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
