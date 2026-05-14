import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance } from '../../mocks/homey';
import { PriceCoordinator } from '../../../lib/price/priceCoordinator';
import { PriceLevel } from '../../../lib/price/priceLevels';
import { COMBINED_PRICES, FLOW_PRICES_TODAY, PRICE_SCHEME } from '../../../lib/utils/settingsKeys';

const createCoordinator = () => new PriceCoordinator({
  homey: mockHomeyInstance as never,
  getCurrentPriceLevel: () => PriceLevel.NORMAL,
  rebuildPlanFromCache: async () => undefined,
  log: () => undefined,
  logDebug: () => undefined,
  error: () => undefined,
});

describe('PriceCoordinator midnight rotation scheduler', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'flow');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules updateCombinedPrices to fire shortly after the next local midnight', () => {
    // 2026-05-10 22:30 in Europe/Oslo (CEST = UTC+2) -> 20:30Z. Local midnight is 22:00Z,
    // and the rotation fires at 22:00:30Z (30s offset). Total wait = 90m 30s.
    vi.useFakeTimers().setSystemTime(new Date('2026-05-10T20:30:00.000Z'));

    const coordinator = createCoordinator();
    const updateSpy = vi.spyOn(coordinator, 'updateCombinedPrices');

    coordinator.startPriceRefresh();
    expect(updateSpy).not.toHaveBeenCalled();

    // Just before the scheduled fire.
    vi.advanceTimersByTime(90 * 60 * 1000 + 29 * 1000);
    expect(updateSpy).not.toHaveBeenCalled();

    // Cross 00:00:30 local (22:00:30 UTC).
    vi.advanceTimersByTime(2_000);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    coordinator.stop();
  });

  it('reschedules itself for the following midnight after firing', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-10T20:30:00.000Z'));

    const coordinator = createCoordinator();
    const updateSpy = vi.spyOn(coordinator, 'updateCombinedPrices');

    coordinator.startPriceRefresh();

    // Advance past the first midnight (00:00:30 local on 2026-05-11).
    vi.advanceTimersByTime(91 * 60 * 1000);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // Advance ~24h to cross the next midnight.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(updateSpy).toHaveBeenCalledTimes(2);

    coordinator.stop();
  });

  it('keeps firing even when an updateCombinedPrices invocation throws', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-10T20:30:00.000Z'));

    const errorLog = vi.fn();
    const coordinator = new PriceCoordinator({
      homey: mockHomeyInstance as never,
      getCurrentPriceLevel: () => PriceLevel.NORMAL,
      rebuildPlanFromCache: async () => undefined,
      log: () => undefined,
      logDebug: () => undefined,
      error: errorLog,
    });
    const updateSpy = vi.spyOn(coordinator, 'updateCombinedPrices').mockImplementationOnce(() => {
      throw new Error('boom');
    });

    coordinator.startPriceRefresh();
    vi.advanceTimersByTime(91 * 60 * 1000);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith('Midnight price rotation failed', expect.any(Error));

    // Next midnight still fires.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(updateSpy).toHaveBeenCalledTimes(2);

    coordinator.stop();
  });

  it('stop() clears the pending midnight rotation timer', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-10T20:30:00.000Z'));

    const coordinator = createCoordinator();
    const updateSpy = vi.spyOn(coordinator, 'updateCombinedPrices');

    coordinator.startPriceRefresh();
    coordinator.stop();

    vi.advanceTimersByTime(48 * 60 * 60 * 1000);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('rotates flow-scheme combined prices on midnight without external triggers', () => {
    // Without the scheduler, COMBINED_PRICES retains yesterday's classification indefinitely
    // until something invokes updateCombinedPrices. With the scheduler, the local-day
    // rollover is reflected within seconds of midnight.
    vi.useFakeTimers().setSystemTime(new Date('2026-05-10T20:30:00.000Z'));

    const pricesByHour = Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour), 0.10 + hour * 0.01]),
    );
    mockHomeyInstance.settings.set(FLOW_PRICES_TODAY, {
      dateKey: '2026-05-10',
      pricesByHour,
      updatedAt: '2026-05-10T20:00:00.000Z',
    });

    const coordinator = createCoordinator();
    coordinator.startPriceRefresh();
    // Initial publish so we have a baseline to compare against.
    coordinator.updateCombinedPrices();

    const beforeMidnight = mockHomeyInstance.settings.get(COMBINED_PRICES) as
      | { days?: Record<string, unknown> }
      | undefined;
    expect(Object.keys(beforeMidnight?.days ?? {})).toContain('2026-05-10');

    // Cross local midnight (90m 30s from 20:30Z to 22:00:30Z).
    vi.advanceTimersByTime(91 * 60 * 1000);

    const afterMidnight = mockHomeyInstance.settings.get(COMBINED_PRICES) as
      | { days?: Record<string, unknown> }
      | undefined;
    // Yesterday (2026-05-10) is now outside the today/tomorrow window for the flow scheme.
    expect(afterMidnight?.days?.['2026-05-10']).toBeUndefined();

    coordinator.stop();
  });
});
