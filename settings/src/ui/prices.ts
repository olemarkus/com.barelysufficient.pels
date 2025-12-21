import type { TargetDeviceSnapshot } from '../../../types';
import {
  priceAreaSelect,
  providerSurchargeInput,
  priceThresholdInput,
  priceMinDiffInput,
  priceOptimizationList,
  priceOptimizationEmpty,
  priceOptimizationSection,
  priceOptimizationEnabledCheckbox,
  nettleieFylkeSelect,
  nettleieCompanySelect,
  nettleieOrgnrInput,
  nettleieTariffgruppeSelect,
  priceStatusBadge,
} from './dom';
import { getSetting, setSetting } from './homey';
import { showToast } from './toast';
import { defaultPriceOptimizationConfig, state } from './state';
import { gridCompanies } from './gridCompanies';
import { renderPrices } from './priceRender';
import type { CombinedPriceData, PriceEntry } from './priceTypes';

type NettleieEntry = {
  time: number;
  energileddEks: number | null;
  energileddInk: number | null;
  fastleddEks: number | null;
  fastleddInk: number | null;
  datoId: string;
};

export const loadPriceSettings = async () => {
  const priceArea = await getSetting('price_area');
  const providerSurcharge = await getSetting('provider_surcharge');
  const thresholdPercent = await getSetting('price_threshold_percent');
  const minDiffOre = await getSetting('price_min_diff_ore');
  const priceOptEnabled = await getSetting('price_optimization_enabled');

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
};

type PriceSettingsInput = {
  priceArea: string;
  providerSurcharge: number;
  thresholdPercent: number;
  minDiffOre: number;
};

const parsePriceSettingsInputs = (): PriceSettingsInput => ({
  priceArea: priceAreaSelect?.value || 'NO1',
  providerSurcharge: parseFloat(providerSurchargeInput?.value || '0') || 0,
  thresholdPercent: parseInt(priceThresholdInput?.value || '25', 10) || 25,
  minDiffOre: parseInt(priceMinDiffInput?.value || '0', 10) || 0,
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

export const savePriceSettings = async () => {
  const { priceArea, providerSurcharge, thresholdPercent, minDiffOre } = parsePriceSettingsInputs();

  validatePriceArea(priceArea);
  validateNumberRange(providerSurcharge, -100, 1000, 'Provider surcharge must be between -100 and 1000 øre.');
  validateNumberRange(thresholdPercent, 0, 100, 'Threshold must be between 0 and 100%.');
  validateNumberRange(minDiffOre, 0, 1000, 'Minimum difference must be between 0 and 1000 øre.');

  await setSetting('price_area', priceArea);
  await setSetting('provider_surcharge', providerSurcharge);
  await setSetting('price_threshold_percent', thresholdPercent);
  await setSetting('price_min_diff_ore', minDiffOre);
  await showToast('Price settings saved.', 'ok');
};

const getPriceData = async (): Promise<CombinedPriceData | null> => {
  const combinedData = await getSetting('combined_prices');
  if (combinedData && typeof combinedData === 'object' && 'prices' in combinedData) {
    return combinedData as CombinedPriceData;
  }
  if (combinedData && Array.isArray(combinedData) && combinedData.length > 0) {
    const prices = combinedData as PriceEntry[];
    const avgPrice = prices.reduce((sum, p) => sum + p.total, 0) / prices.length;
    return {
      prices,
      avgPrice,
      lowThreshold: avgPrice * 0.75,
      highThreshold: avgPrice * 1.25,
    };
  }
  const priceData = await getSetting('electricity_prices');
  if (!priceData || !Array.isArray(priceData) || priceData.length === 0) return null;
  const prices = priceData as PriceEntry[];
  const avgPrice = prices.reduce((sum, p) => sum + p.total, 0) / prices.length;
  return {
    prices,
    avgPrice,
    lowThreshold: avgPrice * 0.75,
    highThreshold: avgPrice * 1.25,
  };
};

export const refreshPrices = async () => {
  try {
    const prices = await getPriceData();
    renderPrices(prices);
  } catch (error) {
    console.error('Failed to load prices:', error);
    if (priceStatusBadge) {
      priceStatusBadge.textContent = 'Error';
      priceStatusBadge.classList.add('warn');
    }
  }
};

export const updateGridCompanyOptions = (fylkeNr: string) => {
  if (!nettleieCompanySelect) return;

  const currentValue = nettleieOrgnrInput?.value || '';
  nettleieCompanySelect.innerHTML = '<option value="">-- Select grid company --</option>';

  const filteredCompanies = gridCompanies
    .filter(c => c.fylker.includes(fylkeNr))
    .sort((a, b) => a.name.localeCompare(b.name));

  filteredCompanies.forEach(company => {
    const opt = document.createElement('option');
    opt.value = company.orgnr;
    opt.textContent = company.name;
    if (company.orgnr === currentValue) opt.selected = true;
    nettleieCompanySelect.appendChild(opt);
  });
};

export const loadNettleieSettings = async () => {
  const fylke = await getSetting('nettleie_fylke');
  const orgnr = await getSetting('nettleie_orgnr');
  const tariffgruppe = await getSetting('nettleie_tariffgruppe');

  if (nettleieFylkeSelect && typeof fylke === 'string') {
    nettleieFylkeSelect.value = fylke;
  }

  updateGridCompanyOptions(typeof fylke === 'string' ? fylke : '03');

  if (nettleieOrgnrInput && typeof orgnr === 'string') {
    nettleieOrgnrInput.value = orgnr;
    if (nettleieCompanySelect) {
      nettleieCompanySelect.value = orgnr;
    }
  }
  if (nettleieTariffgruppeSelect && typeof tariffgruppe === 'string') {
    nettleieTariffgruppeSelect.value = tariffgruppe;
  }
};

export const saveNettleieSettings = async () => {
  const fylke = nettleieFylkeSelect?.value || '03';
  const orgnr = nettleieCompanySelect?.value || '';
  const tariffgruppe = nettleieTariffgruppeSelect?.value || 'Husholdning';

  if (nettleieOrgnrInput) nettleieOrgnrInput.value = orgnr;

  await setSetting('nettleie_fylke', fylke);
  await setSetting('nettleie_orgnr', orgnr);
  await setSetting('nettleie_tariffgruppe', tariffgruppe);
  await showToast('Grid tariff settings saved.', 'ok');

  await setSetting('refresh_nettleie', Date.now());
  await refreshNettleie();
};

const getNettleieData = async (): Promise<NettleieEntry[]> => {
  const data = await getSetting('nettleie_data');
  if (!data || !Array.isArray(data)) return [];
  return data as NettleieEntry[];
};

export const refreshNettleie = async () => {
  try {
    await getNettleieData();
  } catch (error) {
    console.error('Failed to load nettleie:', error);
  }
};

export const loadPriceOptimizationSettings = async () => {
  const settings = await getSetting('price_optimization_settings');
  if (settings && typeof settings === 'object') {
    state.priceOptimizationSettings = settings as Record<string, typeof defaultPriceOptimizationConfig>;
  }
};

export const savePriceOptimizationSettings = async () => {
  await setSetting('price_optimization_settings', state.priceOptimizationSettings);
};

const getPriceOptimizationConfig = (deviceId: string) => (
  state.priceOptimizationSettings[deviceId] || { ...defaultPriceOptimizationConfig }
);

const ensurePriceOptimizationConfig = (deviceId: string) => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { ...defaultPriceOptimizationConfig };
  }
  return state.priceOptimizationSettings[deviceId];
};

const buildPriceOptimizationRow = (device: TargetDeviceSnapshot) => {
  const config = getPriceOptimizationConfig(device.id);

  const row = document.createElement('div');
  row.className = 'device-row price-optimization-row';
  row.setAttribute('role', 'listitem');
  row.dataset.deviceId = device.id;

  const nameWrap = document.createElement('div');
  nameWrap.className = 'device-row__name';
  nameWrap.textContent = device.name;

  const cheapInput = document.createElement('input');
  cheapInput.type = 'number';
  cheapInput.step = '0.5';
  cheapInput.min = '-20';
  cheapInput.max = '20';
  cheapInput.className = 'price-opt-input';
  cheapInput.value = (config.cheapDelta ?? 5).toString();
  cheapInput.title = 'Temperature adjustment during cheap hours (e.g., +5 to boost)';
  cheapInput.addEventListener('change', async () => {
    const val = parseFloat(cheapInput.value);
    if (Number.isFinite(val)) {
      const nextConfig = ensurePriceOptimizationConfig(device.id);
      nextConfig.cheapDelta = val;
      await savePriceOptimizationSettings();
    }
  });

  const expensiveInput = document.createElement('input');
  expensiveInput.type = 'number';
  expensiveInput.step = '0.5';
  expensiveInput.min = '-20';
  expensiveInput.max = '20';
  expensiveInput.className = 'price-opt-input';
  expensiveInput.value = (config.expensiveDelta ?? -5).toString();
  expensiveInput.title = 'Temperature adjustment during expensive hours (e.g., -5 to reduce)';
  expensiveInput.addEventListener('change', async () => {
    const val = parseFloat(expensiveInput.value);
    if (Number.isFinite(val)) {
      const nextConfig = ensurePriceOptimizationConfig(device.id);
      nextConfig.expensiveDelta = val;
      await savePriceOptimizationSettings();
    }
  });

  row.append(nameWrap, cheapInput, expensiveInput);
  return row;
};

export const renderPriceOptimization = (devices: TargetDeviceSnapshot[]) => {
  if (!priceOptimizationList) return;
  priceOptimizationList.innerHTML = '';

  const enabledDevices = (devices || []).filter((device) => {
    const config = state.priceOptimizationSettings[device.id];
    return config?.enabled === true;
  });

  if (enabledDevices.length === 0) {
    if (priceOptimizationSection) priceOptimizationSection.hidden = true;
    if (priceOptimizationEmpty) priceOptimizationEmpty.hidden = false;
    return;
  }

  if (priceOptimizationSection) priceOptimizationSection.hidden = false;
  if (priceOptimizationEmpty) priceOptimizationEmpty.hidden = true;

  enabledDevices.forEach((device) => {
    priceOptimizationList.appendChild(buildPriceOptimizationRow(device));
  });
};
