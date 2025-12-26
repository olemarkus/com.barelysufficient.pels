import { PriceLevel, PRICE_LEVEL_OPTIONS, getPriceLevelFromTitle, getPriceLevelTitle } from '../lib/price/priceLevels';
import { updatePelsStatusDirect } from '../lib/plan/planService';
import { mockHomeyInstance } from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

describe('Price level helpers', () => {
  it('exposes enum values and option metadata', () => {
    expect(PriceLevel.CHEAP).toBe('cheap');
    expect(PriceLevel.NORMAL).toBe('normal');
    expect(PriceLevel.EXPENSIVE).toBe('expensive');
    expect(PriceLevel.UNKNOWN).toBe('unknown');

    expect(PRICE_LEVEL_OPTIONS).toEqual([
      { id: PriceLevel.CHEAP, name: 'Cheap' },
      { id: PriceLevel.NORMAL, name: 'Normal' },
      { id: PriceLevel.EXPENSIVE, name: 'Expensive' },
      { id: PriceLevel.UNKNOWN, name: 'Unknown' },
    ]);
  });

  it('maps between ids and names case-insensitively', () => {
    expect(getPriceLevelTitle(PriceLevel.EXPENSIVE)).toBe('Expensive');
    expect(getPriceLevelFromTitle('cheap')).toBe(PriceLevel.CHEAP);
    expect(getPriceLevelFromTitle('NORMAL')).toBe(PriceLevel.NORMAL);
    expect(getPriceLevelFromTitle('invalid')).toBe(PriceLevel.UNKNOWN);
  });
});

describe('Price level flow cards', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
  });

  it('returns autocomplete options for price_level_changed trigger', async () => {
    const app = createApp();
    (app as any).registerFlowCards();

    const listener = mockHomeyInstance.flow._triggerCardAutocompleteListeners?.price_level_changed?.level;
    expect(typeof listener).toBe('function');

    const results = await listener('che');
    expect(results).toEqual([{ id: PriceLevel.CHEAP, name: 'Cheap' }]);
  });

  it('matches price_level_is condition against stored status', async () => {
    const app = createApp();
    (app as any).registerFlowCards();
    mockHomeyInstance.settings.set('pels_status', { priceLevel: PriceLevel.EXPENSIVE });

    const listener = mockHomeyInstance.flow._conditionCardListeners.price_level_is;
    expect(typeof listener).toBe('function');

    await expect(listener({ level: { id: PriceLevel.EXPENSIVE, name: 'Expensive' } })).resolves.toBe(true);
    await expect(listener({ level: PriceLevel.CHEAP })).resolves.toBe(false);
  });

  it('emits price_level_changed with state when level flips', () => {
    const app = createApp();
    (app as any).priceCoordinator = {
      isCurrentHourCheap: () => true,
      isCurrentHourExpensive: () => false,
    };
    (app as any).registerFlowCards();
    mockHomeyInstance.settings.set('combined_prices', { prices: [{ total: 10 }] });

    updatePelsStatusDirect({
      homey: mockHomeyInstance as any,
      plan: {
        meta: { totalKw: null, softLimitKw: 0, headroomKw: null },
        devices: [],
      },
      isCheap: true,
      isExpensive: false,
      combinedPrices: mockHomeyInstance.settings.get('combined_prices'),
      lastPowerUpdate: null,
      lastNotifiedPriceLevel: PriceLevel.UNKNOWN,
      error: jest.fn(),
    });

    const triggers = mockHomeyInstance.flow._triggerCardTriggers.price_level_changed;
    expect(triggers?.[0]?.tokens?.level).toBe(PriceLevel.CHEAP);
    expect(triggers?.[0]?.state?.priceLevel).toBe(PriceLevel.CHEAP);
  });
});
