import { getSetting } from './homey';
import { NORWAY_PRICE_MODEL, PRICE_SCHEME } from '../../../lib/utils/settingsKeys';

export type PriceScheme = 'norway' | 'flow' | 'homey';
export type NorwayPriceModel = 'stromstotte' | 'norgespris';

export type PriceSettingsInput = {
  priceScheme: PriceScheme;
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

export const normalizePriceSchemeSetting = (value: unknown): PriceScheme => {
  if (value === 'norway' || value === 'flow' || value === 'homey') return value;
  return 'norway';
};

export const normalizePriceSchemeSelection = (value: unknown): PriceScheme => {
  if (value === 'norway' || value === 'flow' || value === 'homey') return value;
  return 'homey';
};

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
  norwayPriceModelValue: unknown;
  priceAreaValue: string | undefined;
  providerSurchargeValue: string | undefined;
  thresholdPercentValue: string | undefined;
  minDiffOreValue: string | undefined;
}): PriceSettingsInput => ({
  priceScheme: normalizePriceSchemeSelection(params.priceSchemeValue),
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
  ] = await Promise.all([
    getSetting(PRICE_SCHEME),
    getSetting(NORWAY_PRICE_MODEL),
    getSetting('price_area'),
    getSetting('provider_surcharge'),
    getSetting('price_threshold_percent'),
    getSetting('price_min_diff_ore'),
  ]);

  return {
    priceScheme: normalizePriceSchemeSetting(currentSchemeRaw),
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
