import type {
  NorwayPriceModelSetting,
  NorwayPriceSetup,
  PriceSchemeSetting,
  SettingsUiPricesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { getFlowPricePayload } from '../../../shared-domain/src/price/flowPriceUtils.ts';
import { gridCompanies } from './gridCompanies.ts';

/**
 * How far the owner has set up prices: which source PELS is pricing from, and
 * which of the values it prices with are the owner's and which PELS assumed.
 *
 * The page shows an assumed value as an assumption, never as a choice, and the
 * surfaces where price behaviour is turned on (Price-aware devices, a device's
 * Price-based control, the setup path) say whether prices are set up at all.
 * All of them read the runtime's `priceSetup` through here, so they agree.
 */

/** Why the source select shows what it does, when the owner never chose it. */
export type PriceSourceAssumption =
  | { kind: 'none' }
  | { kind: 'assumed'; reason: 'in_norway' | 'outside_norway' | 'location_unknown' };

/**
 * The Norway settings PELS fills in for the owner, each with the value it
 * prices with, as the runtime reports it. `chosen` means there is nothing to
 * flag: the owner chose it. The grid company needs no entry: the page holds
 * the stored one, and an empty one is never a default PELS prices with.
 */
export type NorwayChoices =
  | { kind: 'unknown' }
  | { kind: 'resolved'; choices: Pick<NorwayPriceSetup, 'county' | 'pricingModel' | 'priceArea'> };

export type ResolvedPriceSetupStatus = { state: 'complete' | 'open'; summary: string };

export type PriceSetupStatus = { state: 'unavailable' } | ResolvedPriceSetupStatus;

/**
 * Only when the read describes the source the page shows: right after the owner
 * picks a source the cached read can still describe the one before.
 */
export const resolvePriceSourceAssumption = (
  read: SettingsUiPricesPayload['priceSetup'],
  shownScheme: PriceSchemeSetting,
): PriceSourceAssumption => {
  if (read.state !== 'resolved' || read.setup.source.scheme !== shownScheme) return { kind: 'none' };
  const { basis } = read.setup.source;
  if (basis.kind === 'chosen') return { kind: 'none' };
  if (basis.kind === 'default') return { kind: 'assumed', reason: 'location_unknown' };
  return { kind: 'assumed', reason: basis.country === 'NO' ? 'in_norway' : 'outside_norway' };
};

/** `unknown` without the read: the page then claims nothing it does not know. */
export const resolveNorwayChoices = (read: SettingsUiPricesPayload['priceSetup']): NorwayChoices => {
  if (read.state !== 'resolved') return { kind: 'unknown' };
  const { county, pricingModel, priceArea } = read.setup.norway;
  return { kind: 'resolved', choices: { county, pricingModel, priceArea } };
};

/**
 * Whether Homey Energy has given PELS any prices for this hub. Outside Norway
 * Homey Energy is the source PELS assumes, and a hub Homey has no prices for
 * leaves PELS with none at all.
 */
export const homeyEnergyHasPrices = (
  payload: Pick<SettingsUiPricesPayload, 'homeyToday' | 'homeyTomorrow'>,
): boolean => (
  getFlowPricePayload(payload.homeyToday) !== null || getFlowPricePayload(payload.homeyTomorrow) !== null
);

export const NORWAY_PRICE_MODEL_NAMES: Record<NorwayPriceModelSetting, string> = {
  stromstotte: 'Strømstøtte',
  norgespris: 'Norgespris',
};

const gridCompanyName = (organizationNumber: string): string => (
  gridCompanies.find((company) => company.organizationNumber === organizationNumber)?.name
  ?? 'your grid company'
);

const joinAnd = (items: string[]): string => (
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
);

const resolveNorwayStatus = (norway: NorwayPriceSetup): PriceSetupStatus => {
  const { gridCompany, priceArea, pricingModel } = norway;
  const model = NORWAY_PRICE_MODEL_NAMES[pricingModel.value];
  if (gridCompany.kind === 'chosen' && priceArea.chosen && pricingModel.chosen) {
    return {
      state: 'complete',
      summary: `Norway · ${gridCompanyName(gridCompany.organizationNumber)} · ${priceArea.value} · ${model}`,
    };
  }
  const lead = gridCompany.kind === 'chosen'
    ? `Norway · ${gridCompanyName(gridCompany.organizationNumber)}`
    : 'Norway, without your grid tariff';
  const assumed = [
    ...(priceArea.chosen ? [] : [priceArea.value]),
    ...(pricingModel.chosen ? [] : [model]),
  ];
  const tail = assumed.length > 0
    ? `PELS uses ${joinAnd(assumed)} until you choose.`
    : 'Choose your grid company to include it.';
  return { state: 'open', summary: `${lead}. ${tail}` };
};

const SOURCE_NAMES: Record<Exclude<PriceSchemeSetting, 'norway'>, string> = {
  homey: 'Homey Energy',
  flow: 'Flow',
  powerhour: 'Power by the Hour',
};

/**
 * Prices are set up when the owner chose the source and the source can price
 * the home: on Norway's own source that takes the grid company, the price area
 * and the pricing model, and Homey Energy must have prices for this hub in a
 * price setup PELS can work out.
 */
export const resolvePriceSetupStatus = (
  payload: Pick<SettingsUiPricesPayload, 'priceSetup' | 'homeyToday' | 'homeyTomorrow' | 'homeyPriceFormula'>,
): PriceSetupStatus => {
  const read = payload.priceSetup;
  if (read.state !== 'resolved') return { state: 'unavailable' };
  const { source, norway } = read.setup;
  if (source.scheme === 'norway') {
    const status = resolveNorwayStatus(norway);
    // Every Norway setting saved marks the source chosen, so this only guards
    // a read taken while PELS still holds a switch it is settling.
    return status.state === 'complete' && source.basis.kind !== 'chosen'
      ? { state: 'open', summary: 'PELS uses the Norway source until you choose one.' }
      : status;
  }
  if (source.scheme === 'homey') {
    if (!homeyEnergyHasPrices(payload)) {
      return { state: 'open', summary: 'Homey Energy has no electricity prices for your Homey yet.' };
    }
    // A price setup in Homey that PELS cannot work out pauses prices, whatever
    // Homey holds; Electricity prices says why.
    const formula = payload.homeyPriceFormula.kind;
    if (formula === 'unsupported' || formula === 'prices_nothing') {
      return { state: 'open', summary: 'PELS can’t use the price setup in Homey Energy.' };
    }
  }
  const name = SOURCE_NAMES[source.scheme];
  return source.basis.kind === 'chosen'
    ? { state: 'complete', summary: name }
    : { state: 'open', summary: `PELS uses ${name} until you choose a source.` };
};
