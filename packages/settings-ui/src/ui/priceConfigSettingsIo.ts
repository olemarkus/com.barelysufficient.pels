import { getSetting, setSetting } from './homey.ts';
import { state } from './state.ts';
import {
  readCurrentPriceSettings,
  resolveChangedPriceSettingWrites,
  parsePriceSettingsInputs,
  normalizeNorwayPriceModel,
  normalizePriceSchemeSetting,
} from './priceSettingsPersistence.ts';
import { readExportPriceSettings } from './exportPriceSettings.ts';
import {
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_SCHEME,
  PV_FORECAST_SOURCE,
} from '../../../contracts/src/settingsKeys.ts';
import { normalizePvForecastSourceSetting } from '../../../shared-domain/src/settings/pvForecastSource.ts';
import type { PriceConfigSettingsPatch, PriceSettingsSaveInput } from './priceConfigTypes.ts';

/**
 * The settings-store side of the Electricity prices page: one batched read that
 * hydrates the page's configuration, and the validate-then-persist pass every
 * field handler runs. Split out of `priceConfig.ts` so that file stays the view
 * controller (state, render props, handlers) and this one owns the store shapes,
 * defaults, and validation bounds.
 */

const stringSetting = (value: unknown, fallback: string): string => (
  typeof value === 'string' && value ? value : fallback
);

const stringSettingOrEmpty = (value: unknown): string => (
  typeof value === 'string' ? value : ''
);

const numberSetting = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

export const validateAndSavePriceSettings = async (input: PriceSettingsSaveInput) => {
  const { priceScheme, norwayPriceModel, priceArea, providerSurcharge, thresholdPercent, minDiffOre } = input;

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

/**
 * Batched read of every price/grid-tariff/export setting the page shows. Also
 * hydrates `state.priceOptimizationSettings` (the per-device map the Price-aware
 * devices list renders from), which is shared UI state rather than page config.
 */
export const readPriceConfigSettings = async (): Promise<PriceConfigSettingsPatch> => {
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
    exportSettings,
    pvForecastSource,
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
    readExportPriceSettings(),
    getSetting(PV_FORECAST_SOURCE),
  ]);

  if (priceOptSettings && typeof priceOptSettings === 'object') {
    state.priceOptimizationSettings = priceOptSettings as typeof state.priceOptimizationSettings;
  }

  return {
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
    exportPriceEnabled: exportSettings.enabled,
    exportSpotFactor: exportSettings.spotFactorPercent,
    exportFixed: exportSettings.fixed,
    pvForecastSource: normalizePvForecastSourceSetting(pvForecastSource),
  };
};
