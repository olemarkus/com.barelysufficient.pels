import {
  SETTINGS_UI_PRICE_SETUP_SUGGESTION_PATH,
  type NorwayPriceSetup,
  type PriceSetupRead,
  type PriceSetupSuggestion,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { gridCompanies } from './gridCompanies.ts';

const ORGANIZATION_NUMBER = /^\d{9}$/;
const COUNTY_CODE = /^\d{2}$/;
const PRICE_AREA = /^NO[1-5]$/;

const NO_SUGGESTION: PriceSetupSuggestion = {
  gridCompany: { kind: 'none' },
  priceArea: { kind: 'none' },
  powerhour: { kind: 'none' },
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const parseGridCompany = (value: unknown): PriceSetupSuggestion['gridCompany'] => {
  const company = asRecord(value);
  if (
    company?.kind !== 'found'
    || typeof company.organizationNumber !== 'string' || !ORGANIZATION_NUMBER.test(company.organizationNumber)
    || typeof company.name !== 'string'
    || typeof company.countyCode !== 'string' || !COUNTY_CODE.test(company.countyCode)
  ) {
    return { kind: 'none' };
  }
  return {
    kind: 'found',
    organizationNumber: company.organizationNumber,
    name: company.name,
    countyCode: company.countyCode,
  };
};

const parsePriceArea = (value: unknown): PriceSetupSuggestion['priceArea'] => {
  const area = asRecord(value);
  return area?.kind === 'from_homey_energy' && typeof area.area === 'string' && PRICE_AREA.test(area.area)
    ? { kind: 'from_homey_energy', area: area.area }
    : { kind: 'none' };
};

/**
 * The runtime's suggestion as it crosses the Homey API bridge, validated once
 * here, each part on its own: a malformed part is a part with nothing to offer.
 */
export const parsePriceSetupSuggestion = (value: unknown): PriceSetupSuggestion => {
  const read = asRecord(value);
  return read
    ? {
      gridCompany: parseGridCompany(read.gridCompany),
      priceArea: parsePriceArea(read.priceArea),
      powerhour: asRecord(read.powerhour)?.kind === 'has_price_device'
        ? { kind: 'has_price_device' }
        : { kind: 'none' },
    }
    : NO_SUGGESTION;
};

/**
 * Asks the runtime for the Norway settings at the hub's location. Advisory: a
 * failure is no suggestion, and the page works as it did.
 */
export const loadPriceSetupSuggestion = async (): Promise<PriceSetupSuggestion> => {
  try {
    return parsePriceSetupSuggestion(await callApi<unknown>('GET', SETTINGS_UI_PRICE_SETUP_SUGGESTION_PATH));
  } catch (error) {
    await logSettingsError('Failed to read the price setup suggestion', error, 'priceConfig');
    return NO_SUGGESTION;
  }
};

type OfferedGridCompany = {
  readonly organizationNumber: string;
  /** The name PELS lists the company under, so the offer matches the field it fills. */
  readonly name: string;
  /** The county to save with it, or the one the owner chose, which it is in. */
  readonly county: { readonly kind: 'set'; readonly code: string } | { readonly kind: 'kept' };
};

/**
 * What the page offers to fill in from the hub's location: only settings the
 * owner has not chosen, and a grid company only when PELS lists it in the
 * county it was found in, so the field it fills can show it.
 */
export type PriceSetupOffer =
  | { readonly kind: 'none' }
  | { readonly kind: 'grid_company'; readonly gridCompany: OfferedGridCompany }
  | { readonly kind: 'grid_company_and_area'; readonly gridCompany: OfferedGridCompany; readonly priceArea: string }
  | { readonly kind: 'price_area'; readonly priceArea: string };

const NO_OFFER: PriceSetupOffer = { kind: 'none' };

/**
 * Whether the page should ask for a suggestion: a Norway setup still missing
 * its grid company or price area, or Homey Energy with no prices, where Power
 * by the Hour may have them.
 */
export const priceSetupNeedsSuggestion = (read: PriceSetupRead, homeyHasPrices: boolean): boolean => {
  if (read.state !== 'resolved') return false;
  if (read.setup.source.scheme === 'homey') return !homeyHasPrices;
  if (read.setup.source.scheme !== 'norway') return false;
  const { norway } = read.setup;
  return norway.gridCompany.kind === 'none' || !norway.priceArea.chosen;
};

const offerGridCompany = (
  suggestion: PriceSetupSuggestion['gridCompany'],
  norway: NorwayPriceSetup,
): OfferedGridCompany | null => {
  if (suggestion.kind !== 'found' || norway.gridCompany.kind !== 'none') return null;
  // A county the owner chose stays: a company found in another one is not offered.
  if (norway.county.chosen && norway.county.value !== suggestion.countyCode) return null;
  const listed = gridCompanies.find((company) => (
    company.organizationNumber === suggestion.organizationNumber && company.countyCodes.includes(suggestion.countyCode)
  ));
  if (!listed) return null;
  return {
    organizationNumber: listed.organizationNumber,
    name: listed.name,
    county: norway.county.chosen ? { kind: 'kept' } : { kind: 'set', code: suggestion.countyCode },
  };
};

export const resolvePriceSetupOffer = (suggestion: PriceSetupSuggestion, read: PriceSetupRead): PriceSetupOffer => {
  if (read.state !== 'resolved') return NO_OFFER;
  const { norway } = read.setup;
  const gridCompany = offerGridCompany(suggestion.gridCompany, norway);
  const area = !norway.priceArea.chosen && suggestion.priceArea.kind === 'from_homey_energy'
    ? suggestion.priceArea.area
    : null;
  if (gridCompany) {
    return area === null
      ? { kind: 'grid_company', gridCompany }
      : { kind: 'grid_company_and_area', gridCompany, priceArea: area };
  }
  return area === null ? NO_OFFER : { kind: 'price_area', priceArea: area };
};
