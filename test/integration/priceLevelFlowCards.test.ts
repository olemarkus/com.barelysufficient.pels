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
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
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

  // The condition asks the price service for the current hour's level — the
  // same producer the `price_level_changed` trigger fires from — never a
  // persisted status blob (the status lives in memory now, and a previous
  // run's level was the wrong answer anyway).
  it('matches price_level_is condition against the current hour\'s level', async () => {
    const app = createApp();
    app.priceCoordinator = partialDouble<MyApp['priceCoordinator']>({
      getCurrentHourPriceLevel: () => PriceLevel.EXPENSIVE,
    });
    app.registerFlowCards();

    const listener = mockHomeyInstance.flow._conditionCardListeners.price_level_is;
    expect(typeof listener).toBe('function');

    await expect(listener({ level: { id: PriceLevel.EXPENSIVE, name: 'Expensive' } })).resolves.toBe(true);
    await expect(listener({ level: PriceLevel.CHEAP })).resolves.toBe(false);
  });

  describe('price_level_changes_within condition', () => {
    const NOW = new Date('2026-06-01T08:30:00Z');

    const register = (read: ReturnType<MyApp['priceCoordinator']['getPriceLevelChangesWithin']>) => {
      const app = createApp();
      const lookahead = vi.fn(() => read);
      app.priceCoordinator = partialDouble<MyApp['priceCoordinator']>({
        getPriceLevelChangesWithin: lookahead,
      });
      vi.spyOn(app, 'getNow').mockReturnValue(NOW);
      app.registerFlowCards();
      const listener = mockHomeyInstance.flow._conditionCardListeners.price_level_changes_within;
      return { listener, lookahead };
    };

    it('asks for the window from now and matches a coming change to the chosen level', async () => {
      const { listener, lookahead } = register({ state: 'resolved', levels: [PriceLevel.NORMAL, PriceLevel.EXPENSIVE] });

      await expect(listener({ level: { id: PriceLevel.EXPENSIVE, name: 'Expensive' }, hours: 3 })).resolves.toBe(true);
      await expect(listener({ level: PriceLevel.CHEAP, hours: 3 })).resolves.toBe(false);
      expect(lookahead).toHaveBeenCalledWith({ nowMs: NOW.getTime(), horizonMs: 3 * 60 * 60 * 1000 });
    });

    it('fails the Flow when prices cannot be read, rather than answering no', async () => {
      const { listener } = register({ state: 'unavailable' });

      await expect(listener({ level: PriceLevel.EXPENSIVE, hours: 3 })).rejects.toThrow('no price for the current period');
    });

    it('rejects a window outside the card\'s 0.25 to 24 hours', async () => {
      const { listener, lookahead } = register({ state: 'resolved', levels: [PriceLevel.EXPENSIVE] });

      await expect(listener({ level: PriceLevel.EXPENSIVE, hours: 0 })).rejects.toThrow('Hours');
      await expect(listener({ level: PriceLevel.EXPENSIVE, hours: 0.1 })).rejects.toThrow('between 0.25 and 24');
      await expect(listener({ level: PriceLevel.EXPENSIVE, hours: 48 })).rejects.toThrow('between 0.25 and 24');
      await expect(listener({ level: PriceLevel.EXPENSIVE })).rejects.toThrow('Hours');
      expect(lookahead).not.toHaveBeenCalled();
    });

    it('does not offer Unknown, which a coming period never changes to', async () => {
      register({ state: 'resolved', levels: [] });
      const autocomplete = mockHomeyInstance.flow._conditionCardAutocompleteListeners
        .price_level_changes_within?.level;

      await expect(autocomplete('')).resolves.toEqual([
        { id: PriceLevel.CHEAP, name: 'Cheap' },
        { id: PriceLevel.NORMAL, name: 'Normal' },
        { id: PriceLevel.EXPENSIVE, name: 'Expensive' },
      ]);
    });
  });

  it('emits price_level_changed with state when level flips', () => {
    const app = createApp();
    app.priceCoordinator = partialDouble<MyApp['priceCoordinator']>({
      getCurrentHourPriceLevel: () => PriceLevel.CHEAP,
    });
    app.registerFlowCards();

    const planService = new PlanService({
      hasStandingCommandGrant: () => false,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getObservedTemperature: () => ({ kind: 'absent' }),
      planBuildGate: openPlanBuildGate(),
      getSteppedSettleDevices: () => [],
      homeId: 'main',
      homey: mockHomeyInstance as unknown as Homey.App['homey'],
      publishPelsStatus: (status) => mockHomeyInstance.settings.set('pels_status', status),
      planEngine: partialDouble<ConstructorParameters<typeof PlanService>[0]['planEngine']>({}),
      getPlanDevices: () => [],
      getSettleDevices: () => [],
      getCapacityDryRun: () => true,
      readSimulationSetting: () => true,
      getCurrentHourPriceLevel: () => PriceLevel.CHEAP,
      getLastPowerUpdate: () => 1_745_000_000_000,
    });

    planService.updatePelsStatus({
      meta: buildPlanMeta({ totalKw: 0, softLimitKw: 0, headroomKw: 0 }),
      devices: [],
    });

    const triggers = mockHomeyInstance.flow._triggerCardTriggers.price_level_changed;
    expect(triggers?.[0]?.tokens?.level).toBe(PriceLevel.CHEAP);
    expect(triggers?.[0]?.state?.priceLevel).toBe(PriceLevel.CHEAP);
  });
});
