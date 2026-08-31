import type Homey from 'homey';
import type MyApp from '../../app.ts';
import { partialDouble } from '../helpers/partialDouble';
import { PriceLevel, PRICE_LEVEL_OPTIONS } from '../../lib/price/priceLevels';
import { PlanService } from '../../lib/plan/planService';
import { mockHomeyInstance } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { openPlanBuildGate, buildPlanMeta } from '../utils/planTestUtils';

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
    app.registerFlowCards();

    const listener = mockHomeyInstance.flow._triggerCardAutocompleteListeners?.price_level_changed?.level;
    expect(typeof listener).toBe('function');

    const results = await listener('che');
    expect(results).toEqual([{ id: PriceLevel.CHEAP, name: 'Cheap' }]);
  });

  it('matches price_level_is condition against stored status', async () => {
    const app = createApp();
    app.registerFlowCards();
    mockHomeyInstance.settings.set('pels_status', { priceLevel: PriceLevel.EXPENSIVE });

    const listener = mockHomeyInstance.flow._conditionCardListeners.price_level_is;
    expect(typeof listener).toBe('function');

    await expect(listener({ level: { id: PriceLevel.EXPENSIVE, name: 'Expensive' } })).resolves.toBe(true);
    await expect(listener({ level: PriceLevel.CHEAP })).resolves.toBe(false);
  });

  it('uses the last live level when persisted status is malformed', async () => {
    const app = createApp();
    app.planService = partialDouble<MyApp['planService']>({ getLastNotifiedPriceLevel: () => PriceLevel.CHEAP });
    app.registerFlowCards();
    mockHomeyInstance.settings.set('pels_status', { priceLevel: 'premium' });

    const listener = mockHomeyInstance.flow._conditionCardListeners.price_level_is;
    await expect(listener({ level: PriceLevel.CHEAP })).resolves.toBe(true);
  });

  it('uses the last live level when persisted status cannot be read', async () => {
    const app = createApp();
    app.planService = partialDouble<MyApp['planService']>({ getLastNotifiedPriceLevel: () => PriceLevel.EXPENSIVE });
    app.registerFlowCards();
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementationOnce(() => {
      throw new Error('settings unavailable');
    });

    const listener = mockHomeyInstance.flow._conditionCardListeners.price_level_is;
    await expect(listener({ level: PriceLevel.EXPENSIVE })).resolves.toBe(true);
  });

  it('emits price_level_changed with state when level flips', () => {
    const app = createApp();
    app.priceCoordinator = partialDouble<MyApp['priceCoordinator']>({
      getCurrentHourPriceLevel: () => PriceLevel.CHEAP,
    });
    app.registerFlowCards();
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
      homey: mockHomeyInstance as unknown as Homey.App['homey'],
      writePelsStatus: (status) => mockHomeyInstance.settings.set('pels_status', status),
      planEngine: partialDouble<ConstructorParameters<typeof PlanService>[0]['planEngine']>({}),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => true,
      getCurrentHourPriceLevel: () => PriceLevel.CHEAP,
      getLastPowerUpdate: () => null,
    });

    planService.updatePelsStatus({
      meta: buildPlanMeta({ totalKw: null, softLimitKw: 0, headroomKw: 0 }),
      devices: [],
    });

    const triggers = mockHomeyInstance.flow._triggerCardTriggers.price_level_changed;
    expect(triggers?.[0]?.tokens?.level).toBe(PriceLevel.CHEAP);
    expect(triggers?.[0]?.state?.priceLevel).toBe(PriceLevel.CHEAP);
  });
});
