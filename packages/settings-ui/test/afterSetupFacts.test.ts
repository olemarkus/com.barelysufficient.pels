import type {
  NorwayPriceSetup,
  PriceLevelSummaryRead,
  PriceSchemeBasis,
  PriceSchemeSetting,
  SettingsUiPricesPayload,
} from '../../contracts/src/settingsUiApi.ts';
import { offerPowerhour, resolvePriceSource } from '../src/ui/afterSetupFacts.ts';
import { loadPriceSetupSuggestion } from '../src/ui/priceSetupOffer.ts';

vi.mock('../src/ui/priceSetupOffer.ts', () => ({ loadPriceSetupSuggestion: vi.fn() }));

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

describe('offering Power by the Hour in place of an assumed Homey Energy', () => {
  const suggesting = (kind: 'has_price_device' | 'none') => vi.mocked(loadPriceSetupSuggestion).mockResolvedValue({
    gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind },
  });

  beforeEach(() => vi.mocked(loadPriceSetupSuggestion).mockReset());

  it('makes an assumed Homey Energy a choice when Power by the Hour has a price device', async () => {
    suggesting('has_price_device');
    await expect(offerPowerhour({ kind: 'priced', scheme: 'homey', chosen: false }))
      .resolves.toEqual({ kind: 'powerhour_offered' });
  });

  it('keeps the source when Power by the Hour has nothing to offer', async () => {
    suggesting('none');
    await expect(offerPowerhour({ kind: 'priced', scheme: 'homey', chosen: false }))
      .resolves.toEqual({ kind: 'priced', scheme: 'homey', chosen: false });
  });

  it('asks Power by the Hour nothing for a chosen source or one without prices', async () => {
    await offerPowerhour({ kind: 'priced', scheme: 'homey', chosen: true });
    await offerPowerhour({ kind: 'needs_setup' });
    expect(loadPriceSetupSuggestion).not.toHaveBeenCalled();
  });
});
