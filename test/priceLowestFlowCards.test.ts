import { mockHomeyInstance } from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

type PriceEntry = { startsAt: string; totalPrice: number };

const buildUtcDay = (dateKey: string, values: number[]): PriceEntry[] => {
  const [year, month, day] = dateKey.split('-').map((part) => Number(part));
  return values.map((price, hour) => ({
    startsAt: new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0)).toISOString(),
    totalPrice: price,
  }));
};

const buildFlatDay = (value: number): number[] => Array.from({ length: 24 }, () => value);

describe('Lowest price flow cards', () => {
  const originalGetTimezone = mockHomeyInstance.clock.getTimezone;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-03T10:05:00.000Z'));
    mockHomeyInstance.clock.getTimezone = () => 'UTC';

    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    mockHomeyInstance.api.clearRealtimeEvents();
  });

  afterEach(async () => {
    await cleanupApps();
    mockHomeyInstance.clock.getTimezone = originalGetTimezone;
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const setupApp = (combinedPrices: PriceEntry[]) => {
    const app = createApp();
    (app as any).priceCoordinator = {
      getCombinedHourlyPrices: () => combinedPrices,
    };
    (app as any).registerFlowCards();
    return app;
  };

  it('condition listeners evaluate price_lowest_today and price_lowest_before', async () => {
    const todayValues = buildFlatDay(70);
    todayValues[8] = 30;
    todayValues[9] = 20;
    todayValues[10] = 5;
    todayValues[11] = 40;

    setupApp(buildUtcDay('2026-03-03', todayValues));

    const todayCondition = mockHomeyInstance.flow._conditionCardListeners.price_lowest_today;
    const beforeCondition = mockHomeyInstance.flow._conditionCardListeners.price_lowest_before;

    expect(typeof todayCondition).toBe('function');
    expect(typeof beforeCondition).toBe('function');

    await expect(todayCondition({ number: 1 })).resolves.toBe(true);
    await expect(beforeCondition({ period: 4, number: 1, time: 12 })).resolves.toBe(true);
    await expect(beforeCondition({ period: 2, number: 1, time: 9 })).resolves.toBe(false);
  });

  it('trigger run listeners mirror the condition listeners for same args/data', async () => {
    const todayValues = buildFlatDay(70);
    todayValues[10] = 12;
    todayValues[11] = 80;
    todayValues[12] = 90;

    setupApp(buildUtcDay('2026-03-03', todayValues));

    const argsToday = { number: 1 };
    const argsBefore = { period: 3, number: 1, time: 13 };

    const todayCondition = mockHomeyInstance.flow._conditionCardListeners.price_lowest_today;
    const todayTrigger = mockHomeyInstance.flow._triggerCardRunListeners.price_lowest_today;
    const beforeCondition = mockHomeyInstance.flow._conditionCardListeners.price_lowest_before;
    const beforeTrigger = mockHomeyInstance.flow._triggerCardRunListeners.price_lowest_before;

    const todayConditionResult = await todayCondition(argsToday);
    const todayTriggerResult = await todayTrigger(argsToday, { current_price: 12 });
    expect(todayTriggerResult).toBe(todayConditionResult);

    const beforeConditionResult = await beforeCondition(argsBefore);
    const beforeTriggerResult = await beforeTrigger(argsBefore, { current_price: 12 });
    expect(beforeTriggerResult).toBe(beforeConditionResult);
  });

  it('trigger listeners prefer current_price from trigger state when provided', async () => {
    const todayValues = buildFlatDay(100);
    todayValues[9] = 10;
    todayValues[10] = 90;

    setupApp(buildUtcDay('2026-03-03', todayValues));

    const todayTrigger = mockHomeyInstance.flow._triggerCardRunListeners.price_lowest_today;
    const triggerResult = await todayTrigger(
      { number: 1 },
      { current_price: 10, triggered_at: '2026-03-03T10:00:00.000Z' },
    );

    expect(triggerResult).toBe(true);
  });
});
