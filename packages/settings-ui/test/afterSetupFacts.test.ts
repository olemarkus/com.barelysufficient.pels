import type {
  NorwayPriceSetup,
  PriceLevelSummaryRead,
  PriceSchemeBasis,
  PriceSchemeSetting,
  SettingsUiPricesPayload,
} from '../../contracts/src/settingsUiApi.ts';
import { resolvePriceSource } from '../src/ui/afterSetupFacts.ts';

const assumed = <T>(value: T) => ({ value, chosen: false });
const chosen = <T>(value: T) => ({ value, chosen: true });

const assumedNorway: NorwayPriceSetup = {
  county: assumed('03'),
  gridCompany: { kind: 'none' },
  tariffGroup: assumed('Husholdning'),
  pricingModel: assumed('stromstotte'),
  priceArea: assumed('NO1'),
};

const pricesReady: PriceLevelSummaryRead = {
  state: 'ready',
  lines: { average: 1, cheapAtOrBelow: 0.8, expensiveFrom: 1.2 },
  lowest: 0.5,
  highest: 1.5,
  hasCheap: true,
  hasExpensive: true,
  priceUnit: 'SEK/kWh',
  suggestion: { kind: 'none' },
};

const payload = (
  scheme: PriceSchemeSetting,
  basis: PriceSchemeBasis,
  norway: NorwayPriceSetup = assumedNorway,
  priceLevelSummary: PriceLevelSummaryRead = pricesReady,
): Pick<SettingsUiPricesPayload, 'priceSetup' | 'priceLevelSummary'> => ({
  priceSetup: { state: 'resolved', setup: { source: { scheme, basis }, norway } },
  priceLevelSummary,
});

describe('where the price suggestion says prices come from', () => {
  it('offers to keep a source PELS assumed from the hub\'s country once it has prices', () => {
    expect(resolvePriceSource(payload('homey', { kind: 'hub_location', country: 'SE' })))
      .toEqual({ kind: 'priced', scheme: 'homey', chosen: false });
  });

  it('sends the owner to set prices up while PELS holds none', () => {
    expect(resolvePriceSource(payload('homey', { kind: 'hub_location', country: 'SE' }, assumedNorway, {
      state: 'unavailable',
    }))).toEqual({ kind: 'needs_setup' });
  });

  it('never offers the Norway source PELS fell back to without knowing where the hub is', () => {
    expect(resolvePriceSource(payload('norway', { kind: 'default' }))).toEqual({ kind: 'needs_setup' });
  });

  it('sends a Norwegian owner to the prices page while a Norway setting is still assumed', () => {
    // Keeping the source alone would leave the setup path's Prices step open.
    expect(resolvePriceSource(payload('norway', { kind: 'hub_location', country: 'NO' })))
      .toEqual({ kind: 'needs_setup' });
    const allChosen: NorwayPriceSetup = {
      ...assumedNorway,
      gridCompany: { kind: 'chosen', organizationNumber: '980489698' },
      pricingModel: chosen('stromstotte'),
      priceArea: chosen('NO1'),
    };
    expect(resolvePriceSource(payload('norway', { kind: 'chosen' }, allChosen)))
      .toEqual({ kind: 'priced', scheme: 'norway', chosen: true });
  });
});
