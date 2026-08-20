import { PriceLevel, PRICE_LEVEL_OPTIONS } from '../../lib/price/priceLevels';
import { PlanService } from '../../lib/plan/planService';
import { mockHomeyInstance } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { openPlanBuildGate } from '../utils/planTestUtils';

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
    vi.clearAllTimers();
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

  it('uses the last live level when persisted status is malformed', async () => {
    const app = createApp();
    (app as any).planService = { getLastNotifiedPriceLevel: () => PriceLevel.CHEAP };
    (app as any).registerFlowCards();
    mockHomeyInstance.settings.set('pels_status', { priceLevel: 'premium' });

    const listener = mockHomeyInstance.flow._conditionCardListeners.price_level_is;
    await expect(listener({ level: PriceLevel.CHEAP })).resolves.toBe(true);
  });

  it('uses the last live level when persisted status cannot be read', async () => {
    const app = createApp();
    (app as any).planService = { getLastNotifiedPriceLevel: () => PriceLevel.EXPENSIVE };
    (app as any).registerFlowCards();
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementationOnce(() => {
      throw new Error('settings unavailable');
    });

    const listener = mockHomeyInstance.flow._conditionCardListeners.price_level_is;
    await expect(listener({ level: PriceLevel.EXPENSIVE })).resolves.toBe(true);
  });

  it('emits price_level_changed with state when level flips', () => {
    const app = createApp();
    (app as any).priceCoordinator = {
      getCurrentHourPriceLevel: () => ({ cheap: true, expensive: false }),
    };
    (app as any).registerFlowCards();
    mockHomeyInstance.settings.set('combined_prices', {
      version: 2,
      days: { '2026-05-10': { hours: [
        { startsAt: '2026-05-10T00:00:00.000Z', total: 10, isCheap: false, isExpensive: false },
      ] } },
      avgPrice: 10, lowThreshold: 5, highThreshold: 15,
      priceScheme: 'norway', priceUnit: 'NOK/kWh',
    });

    const planService = new PlanService({
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      homeId: 'main',
      homey: mockHomeyInstance as any,
      writePelsStatus: (status) => mockHomeyInstance.settings.set('pels_status', status),
      planEngine: {} as any,
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => true,
      getCurrentHourPriceLevel: () => ({ cheap: true, expensive: false }),
      getCombinedPrices: () => mockHomeyInstance.settings.get('combined_prices'),
      getLastPowerUpdate: () => null,
    });

    planService.updatePelsStatus({
      meta: { totalKw: null, softLimitKw: 0, headroomKw: null },
      devices: [],
    } as any);

    const triggers = mockHomeyInstance.flow._triggerCardTriggers.price_level_changed;
    expect(triggers?.[0]?.tokens?.level).toBe(PriceLevel.CHEAP);
    expect(triggers?.[0]?.state?.priceLevel).toBe(PriceLevel.CHEAP);
  });
});
