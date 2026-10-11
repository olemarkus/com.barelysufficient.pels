import { getSetting, invalidateApiCache, setSetting } from './homey.ts';
import { SETTINGS_UI_PRICES_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { getPricesReadModel } from './prices.ts';
import {
  NORWAY_PRICE_MODEL,
  POWERHOUR_DEVICE_ID,
  PRICE_SCHEME,
  PRICE_THRESHOLD_PERCENT,
  PRICE_MIN_DIFF_ORE,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import { isPriceSchemeSetting } from '../../../shared-domain/src/settings/priceScheme.ts';
import type { NorwayPriceModel, PriceScheme, PriceSettingsSaveInput } from './priceConfigTypes.ts';

export type PriceSettingWrite = {
  key: string;
  value: unknown;
};

/**
 * The `<select>` element's current value, which is NOT the stored setting: the
 * form always shows one of the options, so anything else is a malformed read,
 * and the page falls back to the source most homes outside Norway are on
 * rather than silently proposing to switch them to Norway.
 */
export const normalizePriceSchemeSelection = (value: unknown): PriceScheme => (
  isPriceSchemeSetting(value) ? value : 'homey'
);

export const normalizeNorwayPriceModel = (value: unknown): NorwayPriceModel => (
  value === 'norgespris' ? 'norgespris' : 'stromstotte'
);

/**
 * The source the stored export amounts were entered under, which decides what
 * switching away from it does to them. A source the owner saved is that one.
 * Otherwise only the runtime knows which source it has in force, so the cached
 * prices read, which can predate a switch PELS made by itself, is dropped and
 * read again. Without it a switch cannot be judged, so this throws rather than
 * guess.
 */
export const readPriceSchemeInForce = async (): Promise<PriceScheme> => {
  const saved = await getSetting(PRICE_SCHEME);
  if (isPriceSchemeSetting(saved)) return saved;
  invalidateApiCache(SETTINGS_UI_PRICES_PATH);
  const { priceSetup } = await getPricesReadModel();
  if (priceSetup.state !== 'resolved') throw new Error('Could not read which price source PELS is using.');
  return priceSetup.setup.source.scheme;
};

/** Save the price source the owner picked. The only write of `price_scheme`. */
export const savePriceScheme = (scheme: PriceScheme): Promise<void> => setSetting(PRICE_SCHEME, scheme);

const PRICE_AREAS: ReadonlySet<string> = new Set(['NO1', 'NO2', 'NO3', 'NO4', 'NO5']);

export const isPriceArea = (value: string): boolean => PRICE_AREAS.has(value);

/**
 * Save the price area or pricing model the owner picked: the only writes of
 * these keys. Written even when PELS was already pricing with that value,
 * because the write is the owner choosing it.
 */
export const savePriceArea = (area: string): Promise<void> => setSetting('price_area', area);

export const saveNorwayPriceModel = (model: NorwayPriceModel): Promise<void> => setSetting(NORWAY_PRICE_MODEL, model);

/**
 * The writes a save of the page's other fields needs. The price source, price
 * area and pricing model are not among them: each is saved only when the owner
 * picks one (`savePriceScheme`, `savePriceArea`, `saveNorwayPriceModel`), so a
 * form still showing a value PELS assumed cannot save it as the owner's choice.
 */
export const resolveChangedPriceSettingWrites = (
  next: PriceSettingsSaveInput,
  current: PriceSettingsSaveInput,
): PriceSettingWrite[] => {
  const writes: PriceSettingWrite[] = [];
  if (next.powerhourDeviceId !== current.powerhourDeviceId) {
    // `''` rather than `null`: the runtime's read policy treats both as "no
    // choice", and a string keeps the key's stored type from varying.
    writes.push({ key: POWERHOUR_DEVICE_ID, value: next.powerhourDeviceId ?? '' });
  }
  if (next.providerSurcharge !== current.providerSurcharge) {
    writes.push({ key: 'provider_surcharge', value: next.providerSurcharge });
  }
  if (next.thresholdPercent !== current.thresholdPercent) {
    writes.push({ key: PRICE_THRESHOLD_PERCENT, value: next.thresholdPercent });
  }
  if (next.minDiffOre !== current.minDiffOre) {
    writes.push({ key: PRICE_MIN_DIFF_ORE, value: next.minDiffOre });
  }
  return writes;
};
