import {
  NORWAY_PRICE_MODEL,
  POWERHOUR_DEVICE_ID,
  PRICE_SCHEME,
  PRICE_THRESHOLD_PERCENT,
  PRICE_MIN_DIFF_ORE,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import {
  isPriceSchemeSetting,
  readPriceSchemeSetting,
} from '../../../shared-domain/src/settings/priceScheme.ts';
import type { NorwayPriceModel, PriceScheme, PriceSettingsSaveInput } from './priceConfigTypes.ts';

export type PriceSettingWrite = {
  key: string;
  value: unknown;
};

/** The stored setting, through the policy the runtime reads it with. */
export const normalizePriceSchemeSetting = readPriceSchemeSetting;

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

export const resolveChangedPriceSettingWrites = (
  next: PriceSettingsSaveInput,
  current: PriceSettingsSaveInput,
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
    writes.push({ key: PRICE_THRESHOLD_PERCENT, value: next.thresholdPercent });
  }
  if (next.minDiffOre !== current.minDiffOre) {
    writes.push({ key: PRICE_MIN_DIFF_ORE, value: next.minDiffOre });
  }
  return writes;
};
