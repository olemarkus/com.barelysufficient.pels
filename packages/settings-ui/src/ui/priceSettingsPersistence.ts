import { getSetting } from './homey.ts';
import {
  NORWAY_PRICE_MODEL, POWERHOUR_DEVICE_ID, PRICE_SCHEME,
} from '../../../contracts/src/settingsKeys.ts';
import {
  isPriceSchemeSetting,
  readPowerhourDeviceIdSetting,
  readPriceSchemeSetting,
  type PriceSchemeSetting,
} from '../../../shared-domain/src/settings/priceScheme.ts';

/**
 * Declared once, in contracts, and read through one shared policy — see
 * `packages/shared-domain/src/settings/priceScheme.ts` for why this union is
 * no longer written out here.
 */
export type PriceScheme = PriceSchemeSetting;
export type NorwayPriceModel = 'stromstotte' | 'norgespris';

export type PriceSettingsInput = {
  priceScheme: PriceScheme;
  /** The Power by the Hour device the owner picked; `null` while they have not. */
  powerhourDeviceId: string | null;
  norwayPriceModel: NorwayPriceModel;
  priceArea: string;
  providerSurcharge: number;
  thresholdPercent: number;
  minDiffOre: number;
};

export type PriceSettingWrite = {
  key: string;
  value: unknown;
};

/** The stored setting, through the policy the runtime reads it with. */
export const normalizePriceSchemeSetting = readPriceSchemeSetting;

/**
 * The `<select>` element's current value, which is NOT the stored setting: the
 * form always shows one of the options, so anything else means the element was
 * not found, and the page falls back to the source most homes outside Norway
 * are on rather than silently proposing to switch them to Norway.
 */
export const normalizePriceSchemeSelection = (value: unknown): PriceScheme => (
  isPriceSchemeSetting(value) ? value : 'homey'
);

export const normalizeNorwayPriceModel = (value: unknown): NorwayPriceModel => (
  value === 'norgespris' ? 'norgespris' : 'stromstotte'
);

const parseFloatInput = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseIntInput = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const parsePriceSettingsInputs = (params: {
  priceSchemeValue: unknown;
  powerhourDeviceIdValue: unknown;
  norwayPriceModelValue: unknown;
  priceAreaValue: string | undefined;
  providerSurchargeValue: string | undefined;
  thresholdPercentValue: string | undefined;
  minDiffOreValue: string | undefined;
}): PriceSettingsInput => ({
  priceScheme: normalizePriceSchemeSelection(params.priceSchemeValue),
  powerhourDeviceId: readPowerhourDeviceIdSetting(params.powerhourDeviceIdValue),
  norwayPriceModel: normalizeNorwayPriceModel(params.norwayPriceModelValue),
  priceArea: params.priceAreaValue || 'NO1',
  providerSurcharge: parseFloatInput(params.providerSurchargeValue, 0),
  thresholdPercent: parseIntInput(params.thresholdPercentValue, 25),
  minDiffOre: parseFloatInput(params.minDiffOreValue, 0),
});

export const readCurrentPriceSettings = async (): Promise<PriceSettingsInput> => {
  const [
    currentSchemeRaw,
    currentModelRaw,
    currentAreaRaw,
    currentSurchargeRaw,
    currentThresholdRaw,
    currentMinDiffRaw,
    currentPowerhourDeviceRaw,
  ] = await Promise.all([
    getSetting(PRICE_SCHEME),
    getSetting(NORWAY_PRICE_MODEL),
    getSetting('price_area'),
    getSetting('provider_surcharge'),
    getSetting('price_threshold_percent'),
    getSetting('price_min_diff_ore'),
    getSetting(POWERHOUR_DEVICE_ID),
  ]);

  return {
    priceScheme: normalizePriceSchemeSetting(currentSchemeRaw),
    powerhourDeviceId: readPowerhourDeviceIdSetting(currentPowerhourDeviceRaw),
    norwayPriceModel: normalizeNorwayPriceModel(currentModelRaw),
    priceArea: typeof currentAreaRaw === 'string' && currentAreaRaw ? currentAreaRaw : 'NO1',
    providerSurcharge: typeof currentSurchargeRaw === 'number' && Number.isFinite(currentSurchargeRaw)
      ? currentSurchargeRaw
      : 0,
    thresholdPercent: typeof currentThresholdRaw === 'number' && Number.isFinite(currentThresholdRaw)
      ? currentThresholdRaw
      : 25,
    minDiffOre: typeof currentMinDiffRaw === 'number' && Number.isFinite(currentMinDiffRaw)
      ? currentMinDiffRaw
      : 0,
  };
};

export const resolveChangedPriceSettingWrites = (
  next: PriceSettingsInput,
  current: PriceSettingsInput,
): PriceSettingWrite[] => {
  const writes: PriceSettingWrite[] = [];
  if (next.priceScheme !== current.priceScheme) {
    writes.push({ key: PRICE_SCHEME, value: next.priceScheme });
  }
  if (next.powerhourDeviceId !== current.powerhourDeviceId) {
    // `''` rather than `null`: the runtime's read policy treats both as "no
    // choice", and a string keeps the key's stored type from varying.
    writes.push({ key: POWERHOUR_DEVICE_ID, value: next.powerhourDeviceId ?? '' });
  }
  if (next.norwayPriceModel !== current.norwayPriceModel) {
    writes.push({ key: NORWAY_PRICE_MODEL, value: next.norwayPriceModel });
  }
  if (next.priceArea !== current.priceArea) {
    writes.push({ key: 'price_area', value: next.priceArea });
  }
  if (next.providerSurcharge !== current.providerSurcharge) {
    writes.push({ key: 'provider_surcharge', value: next.providerSurcharge });
  }
  if (next.thresholdPercent !== current.thresholdPercent) {
    writes.push({ key: 'price_threshold_percent', value: next.thresholdPercent });
  }
  if (next.minDiffOre !== current.minDiffOre) {
    writes.push({ key: 'price_min_diff_ore', value: next.minDiffOre });
  }
  return writes;
};
