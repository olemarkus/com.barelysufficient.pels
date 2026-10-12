import { getSetting, getSettingFresh, setSetting } from './homey.ts';
import { state } from './state.ts';
import {
  resolveChangedPriceSettingWrites,
  normalizeNorwayPriceModel,
} from './priceSettingsPersistence.ts';
import { readExportPriceSettings } from './exportPriceSettings.ts';
import {
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  POWERHOUR_DEVICE_ID,
  PRICE_SCHEME,
  PV_FORECAST_SOURCE,
  NORWAY_PRICE_MODEL,
  PRICE_THRESHOLD_PERCENT,
  PRICE_MIN_DIFF_ORE,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import { normalizePvForecastSourceSetting } from '../../../shared-domain/src/settings/pvForecastSource.ts';
import { readPowerhourDeviceIdSetting } from '../../../shared-domain/src/settings/priceScheme.ts';
import type { PriceConfigSettingsPatch, PriceSettingsSaveInput } from './priceConfigTypes.ts';
import { classifyPriceOptimizationConfigMap } from './priceOptimizationConfig.ts';
import { getPricesReadModel } from './prices.ts';
import { resolveDisplayedPriceScheme } from './priceSetupRead.ts';

/**
 * The settings-store side of the Electricity prices page: one batched read that
 * hydrates the page's configuration, and the validate-then-persist pass every
 * field handler runs. Split out of `priceConfig.ts` so that file stays the view
 * controller (state, render props, handlers) and this one owns the store shapes,
 * defaults, and validation bounds.
 */

// Every page write of `price_optimization_settings` stores the page's whole
// map, so the map has to follow writes made outside the page, such as a Flow
// card's, or the page's next edit puts the old values back.
let priceOptimizationWritesStarted = 0;
let priceOptimizationWritesSettled: Promise<unknown> = Promise.resolve();

/** Stores the page's price-optimization map. Every edit on the page writes the key through here. */
export const writePriceOptimizationSettings = (): Promise<void> => {
  priceOptimizationWritesStarted += 1;
  const write = setSetting(PRICE_OPTIMIZATION_SETTINGS, state.priceOptimizationSettings);
  priceOptimizationWritesSettled = Promise.allSettled([priceOptimizationWritesSettled, write]);
  return write;
};

/**
 * Re-reads the map after a write to the key, and answers whether it differed
 * from the page's. The read waits for the page's own writes to land: read
 * midway, the store would undo an edit still on its way, such as one of
 * several quick +/- taps. A page write that starts during the read voids it;
 * that write's own change notification reads again.
 */
// A key never written reads as null (a failed read rejects instead), which is a
// home where no device has price or solar settings yet: an empty map, loaded.
const classifyStoredPriceOptimizationMap = (value: unknown): ReturnType<typeof classifyPriceOptimizationConfigMap> => (
  value === null || value === undefined
    ? { state: 'resolved', settings: {} }
    : classifyPriceOptimizationConfigMap(value)
);

export const reloadPriceOptimizationSettings = async (): Promise<boolean> => {
  let started: number;
  do {
    started = priceOptimizationWritesStarted;
    await priceOptimizationWritesSettled;
  } while (started !== priceOptimizationWritesStarted);
  const read = classifyStoredPriceOptimizationMap(await getSettingFresh(PRICE_OPTIMIZATION_SETTINGS));
  if (read.state !== 'resolved' || started !== priceOptimizationWritesStarted) return false;
  state.priceOptimizationSettingsLoaded = true;
  if (JSON.stringify(read.settings) === JSON.stringify(state.priceOptimizationSettings)) return false;
  state.priceOptimizationSettings = read.settings;
  return true;
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

/**
 * The price settings the save validates and writes, as the store holds them.
 *
 * A save diffs against these rather than against the page's config state,
 * because that state runs ahead of the store: each handler that saves through
 * here patches it first, and a failed or rejected save leaves the edit there
 * unsaved, so the next save re-sends it.
 */
export const readCurrentPriceSettings = async (): Promise<PriceSettingsSaveInput> => {
  const [
    priceScheme,
    providerSurcharge,
    thresholdPercent,
    minDiffOre,
    powerhourDeviceId,
    pricesReadModel,
  ] = await Promise.all([
    getSetting(PRICE_SCHEME),
    getSetting('provider_surcharge'),
    getSetting(PRICE_THRESHOLD_PERCENT),
    getSetting(PRICE_MIN_DIFF_ORE),
    getSetting(POWERHOUR_DEVICE_ID),
    getPricesReadModel(),
  ]);

  return {
    // The source in force, not the stored key: a home whose owner never chose
    // one shows the source PELS assumed. The save never writes it back
    // (`resolveChangedPriceSettingWrites`); only picking a source does.
    priceScheme: resolveDisplayedPriceScheme(pricesReadModel.priceSetup, priceScheme),
    powerhourDeviceId: readPowerhourDeviceIdSetting(powerhourDeviceId),
    providerSurcharge: numberSetting(providerSurcharge, 0),
    thresholdPercent: numberSetting(thresholdPercent, 25),
    minDiffOre: numberSetting(minDiffOre, 0),
  };
};

export const validateAndSavePriceSettings = async (input: PriceSettingsSaveInput) => {
  const {
    priceScheme, powerhourDeviceId, providerSurcharge, thresholdPercent, minDiffOre,
  } = input;

  if (priceScheme === 'norway') {
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

  const nextSettings: PriceSettingsSaveInput = {
    priceScheme,
    // Carried through the save rather than defaulted: without it every save of
    // this form would write "no device" over a choice the owner had made.
    powerhourDeviceId,
    providerSurcharge,
    // A whole percent, as the field steps: a fractional entry is stored truncated.
    thresholdPercent: Math.trunc(thresholdPercent),
    minDiffOre,
  };

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
    savedPriceSettings,
    norwayPriceModel,
    priceArea,
    priceOptEnabled,
    countyCode,
    organizationNumber,
    tariffGroup,
    priceOptSettings,
    exportSettings,
    pvForecastSource,
  ] = await Promise.all([
    readCurrentPriceSettings(),
    getSetting(NORWAY_PRICE_MODEL),
    getSetting('price_area'),
    getSetting(PRICE_OPTIMIZATION_ENABLED),
    getSetting('nettleie_fylke'),
    getSetting('nettleie_orgnr'),
    getSetting('nettleie_tariffgruppe'),
    getSetting(PRICE_OPTIMIZATION_SETTINGS),
    readExportPriceSettings(),
    getSetting(PV_FORECAST_SOURCE),
  ]);

  const priceOptimizationRead = classifyStoredPriceOptimizationMap(priceOptSettings);
  if (priceOptimizationRead.state === 'resolved') {
    state.priceOptimizationSettings = priceOptimizationRead.settings;
    state.priceOptimizationSettingsLoaded = true;
  }

  return {
    ...savedPriceSettings,
    norwayPriceModel: normalizeNorwayPriceModel(norwayPriceModel),
    priceArea: stringSetting(priceArea, 'NO1'),
    optimizationEnabled: priceOptEnabled !== false,
    countyCode: stringSetting(countyCode, '03'),
    organizationNumber: stringSettingOrEmpty(organizationNumber),
    tariffGroup: stringSetting(tariffGroup, 'Husholdning'),
    exportPriceEnabled: exportSettings.enabled,
    exportPriceSource: exportSettings.source,
    exportSpotFactor: exportSettings.spotFactorPercent,
    exportFixed: exportSettings.fixed,
    pvForecastSource: normalizePvForecastSourceSetting(pvForecastSource),
  };
};
