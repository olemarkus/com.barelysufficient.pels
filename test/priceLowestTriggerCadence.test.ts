import { mockHomeyInstance } from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';
import { buildFlowDaySlots } from '../lib/price/flowPriceUtils';

type PriceEntry = { startsAt: string; totalPrice: number };

const buildUtcDay = (dateKey: string): PriceEntry[] => {
  const [year, month, day] = dateKey.split('-').map((part) => Number(part));
  return Array.from({ length: 24 }, (_, hour) => ({
    startsAt: new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0)).toISOString(),
    totalPrice: hour,
  }));
};

const buildDstDay = (dateKey: string, timeZone: string): PriceEntry[] => (
  buildFlowDaySlots(dateKey, timeZone).map((slot, index) => ({
    startsAt: slot.startsAt,
    totalPrice: index,
  }))
);

describe('Lowest price trigger cadence', () => {
  const originalGetTimezone = mockHomeyInstance.clock.getTimezone;

  beforeEach(() => {
    jest.useFakeTimers();
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

  const setupApp = () => {
    const app = createApp();
    const combined = [
      ...buildUtcDay('2026-03-03'),
      ...buildUtcDay('2026-03-04'),
    ];
    (app as any).priceCoordinator = {
      getCombinedHourlyPrices: () => combined,
    };
    return app;
  };

  it('triggers at most once per local hour', () => {
    jest.setSystemTime(new Date('2026-03-03T10:05:00.000Z'));
    const app = setupApp();

    (app as any).startPriceLowestTriggerChecker();

    jest.setSystemTime(new Date('2026-03-03T11:00:00.000Z'));
    jest.advanceTimersByTime(30_000);

    jest.setSystemTime(new Date('2026-03-03T12:00:00.000Z'));
    jest.advanceTimersByTime(30_000);

    const beforeTriggers = mockHomeyInstance.flow._triggerCardTriggers.price_lowest_before ?? [];
    const todayTriggers = mockHomeyInstance.flow._triggerCardTriggers.price_lowest_today ?? [];

    expect(beforeTriggers).toHaveLength(2);
    expect(todayTriggers).toHaveLength(2);
  });

  it('invokes both lowest-price trigger cards on hour change with current_price', () => {
    jest.setSystemTime(new Date('2026-03-03T10:30:00.000Z'));
    const app = setupApp();

    (app as any).startPriceLowestTriggerChecker();

    jest.setSystemTime(new Date('2026-03-03T11:00:00.000Z'));
    jest.advanceTimersByTime(30_000);

    const beforeTriggers = mockHomeyInstance.flow._triggerCardTriggers.price_lowest_before ?? [];
    const todayTriggers = mockHomeyInstance.flow._triggerCardTriggers.price_lowest_today ?? [];

    expect(beforeTriggers).toHaveLength(1);
    expect(todayTriggers).toHaveLength(1);
    expect(beforeTriggers[0].tokens.current_price).toBe(11);
    expect(todayTriggers[0].tokens.current_price).toBe(11);
  });

  it('does not retrigger repeatedly within the same hour', () => {
    jest.setSystemTime(new Date('2026-03-03T10:05:00.000Z'));
    const app = setupApp();

    (app as any).startPriceLowestTriggerChecker();

    jest.setSystemTime(new Date('2026-03-03T11:00:00.000Z'));
    jest.advanceTimersByTime(30_000);

    jest.setSystemTime(new Date('2026-03-03T11:30:00.000Z'));
    jest.advanceTimersByTime(30_000);
    jest.advanceTimersByTime(30_000);

    const beforeTriggers = mockHomeyInstance.flow._triggerCardTriggers.price_lowest_before ?? [];
    const todayTriggers = mockHomeyInstance.flow._triggerCardTriggers.price_lowest_today ?? [];

    expect(beforeTriggers).toHaveLength(1);
    expect(todayTriggers).toHaveLength(1);
  });

  it('treats repeated fall-back occurrences as separate local hours', () => {
    jest.setSystemTime(new Date('2024-10-27T00:30:00.000Z'));
    mockHomeyInstance.clock.getTimezone = () => 'Europe/Oslo';

    const app = createApp();
    (app as any).priceCoordinator = {
      getCombinedHourlyPrices: () => buildDstDay('2024-10-27', 'Europe/Oslo'),
    };

    (app as any).startPriceLowestTriggerChecker();

    jest.setSystemTime(new Date('2024-10-27T01:00:00.000Z'));
    jest.advanceTimersByTime(30_000);

    jest.setSystemTime(new Date('2024-10-27T02:00:00.000Z'));
    jest.advanceTimersByTime(30_000);

    const beforeTriggers = mockHomeyInstance.flow._triggerCardTriggers.price_lowest_before ?? [];
    const todayTriggers = mockHomeyInstance.flow._triggerCardTriggers.price_lowest_today ?? [];

    expect(beforeTriggers).toHaveLength(2);
    expect(todayTriggers).toHaveLength(2);
  });
});
