import type {
  NorwayPriceSetup,
  PriceLevelSummaryRead,
  PriceSchemeBasis,
  PriceSchemeSetting,
  SettingsUiPricesPayload,
} from '../../contracts/src/settingsUi/prices.ts';
import { offerPowerhour, readExportPriced, resolvePriceSource } from '../src/ui/afterSetupFacts.ts';
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

describe('whether the home has an export price', () => {
  const timeline = (hasExportPrice: boolean): Pick<SettingsUiPricesPayload, 'priceTimeline'> => ({ priceTimeline: {
    state: 'ready', priceUnit: 'EUR/kWh', hasExportPrice, periods: [],
    lines: { average: 1, cheapAtOrBelow: 0.8, expensiveFrom: 1.2 },
  } });

  it('takes the published prices\' word, and says nothing before they are ready', () => {
    expect(readExportPriced(timeline(true))).toBe(true);
    expect(readExportPriced(timeline(false))).toBe(false);
    expect(readExportPriced({ priceTimeline: { state: 'unavailable', reason: 'no_prices' } })).toBeNull();
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

describe('Belgian battery-only setup', () => {
  it('offers the Flemish period choice for a drivable battery with its default power-limit control', async () => {
    vi.resetModules();
    vi.doMock('../src/ui/homeScope.ts', () => ({
      readHomeMembership: () => ({ state: 'resolved', membershipByDeviceId: {} }),
      subscribeToHomeScope: () => undefined,
    }));
    vi.doMock('../src/ui/deferredObjectiveSettings.ts', () => ({ hasLoadedDeferredObjectiveSettings: () => true }));
    vi.doMock('../src/ui/prices.ts', () => ({
      getPricesReadModel: async () => ({
        ...payload('homey', { kind: 'chosen' }),
        priceOptimizationSetup: {
          state: 'resolved', setup: { enabled: true, configuredDeviceIds: [], solarSurplusDeviceIds: [] },
        },
        priceTimeline: { state: 'unavailable', reason: 'no_prices' },
      }),
    }));
    const after = await import('../src/ui/afterSetupFacts.ts');
    const setup = await import('../src/ui/setupPathFacts.ts');
    const { resolveAfterSetupRecommendations } = await import('../src/ui/afterSetupRecommendations.ts');
    const { state } = await import('../src/ui/state.ts');
    state.devicesLoaded = true;
    state.latestDevices = [{
      id: 'battery', deviceClass: 'battery', batteryControl: 'drivable', powerCapable: true,
    }] as typeof state.latestDevices;
    state.batteryControl = { status: 'resolved', devices: {} };
    state.managedMap = {};
    state.controllableMap = {};
    setup.publishSetupMarket({ state: 'resolved', country: 'BE' });
    setup.publishSetupPower({ state: 'received' });
    setup.publishSetupHardCapRead(false, {
      capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2, dryRun: true, periodMinutes: 60,
    });
    setup.publishSetupPrices({
      respondToPrices: false, budgetShapesByPrice: false, status: { state: 'complete', summary: 'Homey Energy' },
    });
    setup.publishSetupBatteryPlans({});
    await after.loadAfterSetupFacts();
    const recommendations = () => {
      const read = after.readAfterSetupFacts();
      if (read.state !== 'resolved') throw new Error(`Facts are ${read.state}`);
      return resolveAfterSetupRecommendations(read.facts, {}).map((recommendation) => recommendation.id);
    };
    expect(recommendations()).toContain('market:flanders-capacity-period');
    state.controllableMap = { battery: false };
    expect(recommendations()).not.toContain('market:flanders-capacity-period');
    state.controllableMap = {};
    state.latestDevices[0]!.batteryControl = 'needs_homey_api_key';
    expect(recommendations()).not.toContain('market:flanders-capacity-period');
  });
});
