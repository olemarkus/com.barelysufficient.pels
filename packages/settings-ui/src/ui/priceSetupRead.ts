import type {
  NorwayPriceModelSetting,
  NorwayPriceSetup,
  PriceSchemeBasis,
  PriceSchemeSetting,
  PriceSettingChoice,
  PriceSetupRead,
  ResolvedPriceScheme,
} from '../../../contracts/src/settingsUi/prices.ts';
import {
  isPriceSchemeSetting,
  readPriceSchemeSetting,
} from '../../../shared-domain/src/settings/priceScheme.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';

const COUNTRY_CODE = /^[A-Z]{2}$/;

const isNorwayPriceModel = (value: unknown): value is NorwayPriceModelSetting => (
  value === 'stromstotte' || value === 'norgespris'
);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

const readBasis = (value: unknown): PriceSchemeBasis | null => {
  if (!isUnknownRecord(value)) return null;
  if (value.kind === 'chosen' || value.kind === 'default') return { kind: value.kind };
  if (value.kind === 'hub_location' && typeof value.country === 'string' && COUNTRY_CODE.test(value.country)) {
    return { kind: 'hub_location', country: value.country };
  }
  return null;
};

const readSource = (value: unknown): ResolvedPriceScheme | null => {
  if (!isUnknownRecord(value) || !isPriceSchemeSetting(value.scheme)) return null;
  const basis = readBasis(value.basis);
  return basis === null ? null : { scheme: value.scheme, basis };
};

const readChoice = <T>(value: unknown, isValue: (raw: unknown) => raw is T): PriceSettingChoice<T> | null => (
  isUnknownRecord(value) && isValue(value.value) && typeof value.chosen === 'boolean'
    ? { value: value.value, chosen: value.chosen }
    : null
);

const readGridCompany = (value: unknown): NorwayPriceSetup['gridCompany'] | null => {
  if (!isUnknownRecord(value)) return null;
  if (value.kind === 'none') return { kind: 'none' };
  return value.kind === 'chosen' && isNonEmptyString(value.organizationNumber)
    ? { kind: 'chosen', organizationNumber: value.organizationNumber }
    : null;
};

const readNorway = (value: unknown): NorwayPriceSetup | null => {
  if (!isUnknownRecord(value)) return null;
  const county = readChoice(value.county, isNonEmptyString);
  const gridCompany = readGridCompany(value.gridCompany);
  const tariffGroup = readChoice(value.tariffGroup, isNonEmptyString);
  const pricingModel = readChoice(value.pricingModel, isNorwayPriceModel);
  const priceArea = readChoice(value.priceArea, isNonEmptyString);
  if (!county || !gridCompany || !tariffGroup || !pricingModel || !priceArea) return null;
  return { county, gridCompany, tariffGroup, pricingModel, priceArea };
};

/**
 * Classify the Homey API bridge once; inward consumers receive only trusted
 * fields. An app that has not restarted since this field was added does not
 * send it, which reads as unavailable like any other unusable payload.
 */
export const classifyPriceSetupRead = (value: unknown): PriceSetupRead => {
  if (!isUnknownRecord(value) || value.state !== 'resolved' || !isUnknownRecord(value.setup)) {
    return { state: 'unavailable' };
  }
  const source = readSource(value.setup.source);
  const norway = readNorway(value.setup.norway);
  return source && norway ? { state: 'resolved', setup: { source, norway } } : { state: 'unavailable' };
};

/**
 * The price source the page shows and saves against. A source the owner saved
 * is read straight from the setting, which the page's own writes keep current;
 * the prices read is cached and can still describe the source from before a
 * switch the owner just made. Without a saved source the page shows the one the
 * runtime has in force, assumed from the hub's country, and without that read
 * it falls back to the shared read policy.
 */
export const resolveDisplayedPriceScheme = (read: PriceSetupRead, saved: unknown): PriceSchemeSetting => {
  if (isPriceSchemeSetting(saved)) return saved;
  return read.state === 'resolved' ? read.setup.source.scheme : readPriceSchemeSetting(saved);
};
