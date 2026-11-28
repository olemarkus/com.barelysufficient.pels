import type MyApp from '../../app.ts';
import { partialDouble } from '../helpers/partialDouble';
import { PriceLevel, PRICE_LEVEL_OPTIONS } from '../../lib/price/priceLevels';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { PriceCoordinator } from '../../lib/price/priceCoordinator';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { createPriceOptimizationSettingsStore } from '../../lib/price/priceOptimizationSettingsStore';
import { FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW, PRICE_SCHEME, PRICE_THRESHOLD_PERCENT } from '../../lib/utils/settingsKeys';
import { createInMemoryPriceCache } from '../helpers/priceCacheForTests';
import { noHomeyWebApi, unknownHubMarket } from '../helpers/homeyWebApiStub';
import { testLogger } from '../utils/testLogger';

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
    resetMockHomey();
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
});

describe('Price-level publication with no meter readings', () => {
  let coordinator: PriceCoordinator;
  let priceStore: ReturnType<typeof createPriceDataStore>;

  const setPrices = (
    dateKey: string,
    startMs: number,
    durationMinutes: number,
    prices: number[],
    day: typeof FLOW_PRICES_TODAY | typeof FLOW_PRICES_TOMORROW = FLOW_PRICES_TODAY,
  ) => {
    priceStore.writeFlowPayload(day, {
      dateKey,
      pricesByHour: {},
      updatedAt: new Date().toISOString(),
      pricesByPeriod: prices.map((totalPrice, index) => ({
        startsAt: new Date(startMs + index * durationMinutes * 60_000).toISOString(),
        totalPrice,
        durationMinutes,
      })),
    });
    coordinator.updateCombinedPrices();
  };

  const triggers = () => mockHomeyInstance.flow._triggerCardTriggers.price_level_changed ?? [];
  const levels = () => triggers().map((trigger) => trigger.state?.priceLevel);

  beforeEach(() => {
    resetMockHomey();
    vi.useFakeTimers();
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
    priceStore = createPriceDataStore(mockHomeyInstance.settings, createInMemoryPriceCache());
    coordinator = new PriceCoordinator({
      homey: mockHomeyInstance,
      flow: mockHomeyInstance.flow,
      priceDataStore: priceStore,
      priceOptimizationSettingsStore: createPriceOptimizationSettingsStore(mockHomeyInstance.settings),
      getTimeZone: () => 'Europe/Oslo',
      getPowerTracker: () => ({}),
      homeyWebApiGet: noHomeyWebApi,
      readHubMarket: unknownHubMarket,
      readHubLocation: async () => ({ kind: 'unavailable' }),
      error: () => undefined,
      structuredLog: testLogger,
    });
  });

  afterEach(() => {
    coordinator.stop();
    vi.useRealTimers();
  });

  it('publishes every changed native quarter-hour level and the end of the series', () => {
    const start = Date.parse('2026-06-01T08:00:00Z');
    vi.setSystemTime(start);
    setPrices('2026-06-01', start, 15, [3, 1, 1, 3]);
    expect(levels()).toEqual([]);
    coordinator.startPriceRefresh();

    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(levels()).toEqual([PriceLevel.EXPENSIVE]);
    vi.advanceTimersByTime(1);
    expect(triggers()[1]).toMatchObject({
      tokens: { level: PriceLevel.CHEAP },
      state: { priceLevel: PriceLevel.CHEAP },
    });
    vi.advanceTimersByTime(45 * 60_000);
    expect(levels()).toEqual([PriceLevel.EXPENSIVE, PriceLevel.CHEAP, PriceLevel.EXPENSIVE, PriceLevel.UNKNOWN]);
  });

  it('publishes changed inputs inside a period even with the same hourly average', () => {
    const start = Date.parse('2026-06-01T08:00:00Z');
    vi.setSystemTime(start);
    coordinator.startPriceRefresh();

    setPrices('2026-06-01', start, 15, [1, 3, 1, 3]);
    setPrices('2026-06-01', start, 15, [3, 1, 1, 3]);
    mockHomeyInstance.settings.set(PRICE_THRESHOLD_PERCENT, 90);
    coordinator.updateCombinedPrices();
    expect(levels()).toEqual([PriceLevel.CHEAP, PriceLevel.EXPENSIVE, PriceLevel.NORMAL]);
  });

  it('publishes at both occurrences of a repeated local hour and stops on shutdown', () => {
    const start = Date.parse('2026-10-25T00:00:00Z');
    vi.setSystemTime(start);
    setPrices('2026-10-25', start, 60, [1, 3, 1]);
    coordinator.startPriceRefresh();

    vi.advanceTimersByTime(60 * 60_000);
    expect(levels()).toEqual([PriceLevel.CHEAP, PriceLevel.EXPENSIVE]);
    coordinator.stop();
    vi.advanceTimersByTime(60 * 60_000);
    expect(levels()).toEqual([PriceLevel.CHEAP, PriceLevel.EXPENSIVE]);
  });

  it('classifies midnight using the new local day before the cache rotates', () => {
    const midnight = Date.parse('2026-06-01T22:00:00Z');
    vi.setSystemTime(midnight - 1000);
    setPrices('2026-06-01', midnight - 60 * 60_000, 60, [10]);
    setPrices('2026-06-02', midnight, 60, [2, 3], FLOW_PRICES_TOMORROW);
    coordinator.startPriceRefresh();

    vi.advanceTimersByTime(1000);
    expect(levels()).toEqual([PriceLevel.EXPENSIVE, PriceLevel.NORMAL]);
    vi.advanceTimersByTime(30_000);
    expect(levels()).toEqual([PriceLevel.EXPENSIVE, PriceLevel.NORMAL]);
  });

  it('keeps the last published level on a read failure and rechecks after recovery', () => {
    const start = Date.parse('2026-06-01T08:00:00Z');
    vi.setSystemTime(start);
    setPrices('2026-06-01', start, 15, [1, 3]);
    coordinator.startPriceRefresh();
    vi.spyOn(coordinator['priceService'], 'getPriceLevelSchedule').mockImplementationOnce(() => {
      throw new Error('Price settings temporarily unavailable');
    });

    vi.advanceTimersByTime(15 * 60_000);
    expect(levels()).toEqual([PriceLevel.CHEAP]);
    vi.advanceTimersByTime(30_000);
    expect(levels()).toEqual([PriceLevel.CHEAP, PriceLevel.EXPENSIVE]);
  });
});
