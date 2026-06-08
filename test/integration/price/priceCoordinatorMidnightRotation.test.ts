import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance } from '../../mocks/homey';
import { PriceCoordinator } from '../../../lib/price/priceCoordinator';
import { PriceLevel } from '../../../lib/price/priceLevels';
import { COMBINED_PRICES, FLOW_PRICES_TODAY, PRICE_SCHEME } from '../../../lib/utils/settingsKeys';

const createCoordinator = () => new PriceCoordinator({
  homey: mockHomeyInstance as never,
  getTimeZone: () => mockHomeyInstance.clock.getTimezone(),
  getCurrentPriceLevel: () => PriceLevel.NORMAL,
  rebuildPlanFromCache: async () => undefined,
  log: () => undefined,
  debugStructured: () => undefined,
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

    const structuredLog = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const coordinator = new PriceCoordinator({
      homey: mockHomeyInstance as never,
      getTimeZone: () => mockHomeyInstance.clock.getTimezone(),
      getCurrentPriceLevel: () => PriceLevel.NORMAL,
      rebuildPlanFromCache: async () => undefined,
      log: () => undefined,
      debugStructured: () => undefined,
      error: () => undefined,
      structuredLog: structuredLog as never,
    });
    const updateSpy = vi.spyOn(coordinator, 'updateCombinedPrices');
    updateSpy.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    coordinator.startPriceRefresh();

    vi.advanceTimersByTime(91 * 60 * 1000);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(structuredLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'midnight_price_rotation_failed', err: expect.any(Error) }),
    );

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

  it('does not invoke updateCombinedPrices from a pending rotation timer that fires after stop()', () => {
    // Guards the race window between stop() running clearTimeout and an already-queued
    // setTimeout callback executing. The `stopped` flag must short-circuit the callback body.
    vi.useFakeTimers().setSystemTime(new Date('2026-05-10T20:30:00.000Z'));

    // Capture the rotation callback as it's scheduled so we can fire it manually after stop().
    const capturedCallbacks: TimerHandler[] = [];
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
      capturedCallbacks.push(handler);
      // Return an opaque handle; clearTimeout is also stubbed below so it's never used.
      return { __captured: true } as never;
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout').mockImplementation(() => undefined);

    const coordinator = createCoordinator();
    const updateSpy = vi.spyOn(coordinator, 'updateCombinedPrices');

    coordinator.startPriceRefresh();

    // The midnight rotation must have been scheduled.
    const rotationCallback = capturedCallbacks.at(-1);
    expect(typeof rotationCallback).toBe('function');

    // stop() flips the flag (and would call clearTimeout, but our stub no-ops).
    coordinator.stop();

    // Simulate the race: the already-queued timer fires after stop().
    if (typeof rotationCallback === 'function') {
      rotationCallback();
    }

    expect(updateSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  const PRIOR_DAY_LAST_FETCHED = '2026-05-10T20:00:00.000Z'; // 2026-05-10 local (Oslo CEST)
  const SAME_DAY_LAST_FETCHED = '2026-05-11T03:00:00.000Z'; // 2026-05-11 local (05:00 CEST)
  const getStoredLastFetched = (): string | undefined =>
    (mockHomeyInstance.settings.get(COMBINED_PRICES) as { lastFetched?: string } | undefined)?.lastFetched;
  const buildPayload = (lastFetched?: string) => ({
    version: 2,
    days: {},
    avgPrice: 0,
    lowThreshold: 0,
    highThreshold: 0,
    priceScheme: 'flow' as const,
    priceUnit: 'øre/kWh',
    ...(lastFetched ? { lastFetched } : {}),
  });

  it('catches up the rotation on boot when combined_prices is from a prior local day', () => {
    // App boots at 2026-05-11 08:00 local (06:00Z) with a combined_prices payload last
    // fetched the previous local day. The next scheduled midnight is ~16h away, so without
    // a boot catch-up the prior-day classification would linger all day. The rotation
    // republishes the payload, bumping lastFetched into today.
    vi.useFakeTimers().setSystemTime(new Date('2026-05-11T06:00:00.000Z'));
    // Seed today's flow prices so the rebuilt payload is non-empty and carries a fresh lastFetched.
    const pricesByHour = Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour), 0.10 + hour * 0.01]),
    );
    mockHomeyInstance.settings.set(FLOW_PRICES_TODAY, {
      dateKey: '2026-05-11',
      pricesByHour,
      updatedAt: '2026-05-11T05:00:00.000Z',
    });
    mockHomeyInstance.settings.set(COMBINED_PRICES, buildPayload(PRIOR_DAY_LAST_FETCHED));

    const coordinator = createCoordinator();
    coordinator.startPriceRefresh();

    expect(getStoredLastFetched()).not.toBe(PRIOR_DAY_LAST_FETCHED);
    expect(getStoredLastFetched()).toBe('2026-05-11T06:00:00.000Z');

    coordinator.stop();
  });

  it('does not catch up on boot when combined_prices is from the same local day', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-11T06:00:00.000Z'));
    mockHomeyInstance.settings.set(COMBINED_PRICES, buildPayload(SAME_DAY_LAST_FETCHED));

    const coordinator = createCoordinator();
    coordinator.startPriceRefresh();

    // Untouched: same-day payload is left exactly as persisted.
    expect(getStoredLastFetched()).toBe(SAME_DAY_LAST_FETCHED);

    coordinator.stop();
  });

  it('does not catch up on boot when no combined_prices payload exists', () => {
    // A missing/empty SDK read must not trigger a rotation (nor write/delete state).
    vi.useFakeTimers().setSystemTime(new Date('2026-05-11T06:00:00.000Z'));

    const coordinator = createCoordinator();
    coordinator.startPriceRefresh();

    expect(mockHomeyInstance.settings.get(COMBINED_PRICES)).toBeUndefined();

    coordinator.stop();
  });

  it('does not catch up on boot when the persisted payload lacks lastFetched', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-05-11T06:00:00.000Z'));
    mockHomeyInstance.settings.set(COMBINED_PRICES, buildPayload());

    const coordinator = createCoordinator();
    coordinator.startPriceRefresh();

    // No lastFetched means we cannot prove the payload is stale; leave it untouched.
    expect(getStoredLastFetched()).toBeUndefined();

    coordinator.stop();
  });

  it('does not catch up on boot for a non-flow (norway) scheme', () => {
    // For norway the periodic refresher rebuilds combined_prices; the catch-up must
    // no-op so it cannot misfire before startup_price_bootstrap on a transient read.
    vi.useFakeTimers().setSystemTime(new Date('2026-05-11T06:00:00.000Z'));
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'norway');
    // A prior-day V2 payload that WOULD rotate under the flow scheme.
    mockHomeyInstance.settings.set(COMBINED_PRICES, buildPayload(PRIOR_DAY_LAST_FETCHED));

    const coordinator = createCoordinator();
    coordinator.startPriceRefresh();

    // Untouched: catch-up no-ops for norway, so lastFetched stays the prior-day value.
    expect(getStoredLastFetched()).toBe(PRIOR_DAY_LAST_FETCHED);

    coordinator.stop();
  });

  it('does not abort startup when the boot catch-up rotation throws', () => {
    // Eligible prior-day flow payload; if updateCombinedPrices throws, startPriceRefresh
    // must swallow it (mirrors the midnight timer's guard) so app boot is not aborted.
    vi.useFakeTimers().setSystemTime(new Date('2026-05-11T06:00:00.000Z'));
    mockHomeyInstance.settings.set(COMBINED_PRICES, buildPayload(PRIOR_DAY_LAST_FETCHED));

    const structuredLog = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const coordinator = new PriceCoordinator({
      homey: mockHomeyInstance as never,
      getTimeZone: () => mockHomeyInstance.clock.getTimezone(),
      getCurrentPriceLevel: () => PriceLevel.NORMAL,
      rebuildPlanFromCache: async () => undefined,
      log: () => undefined,
      debugStructured: () => undefined,
      error: () => undefined,
      structuredLog: structuredLog as never,
    });
    const updateSpy = vi.spyOn(coordinator, 'updateCombinedPrices');
    updateSpy.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    expect(() => coordinator.startPriceRefresh()).not.toThrow();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(structuredLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'combined_prices_catchup_rotation_failed', err: expect.any(Error) }),
    );

    coordinator.stop();
  });

  it('does not bypass the V1→V2 migration for a legacy V1 payload (and does not drop it)', () => {
    // A prior-day legacy V1 payload would, under the old behaviour, be rebuilt into a
    // fresh V2 here — bypassing readPriceStore's V1→V2 migration. The catch-up must
    // leave the V1 payload intact so the next readPriceStore caller migrates it.
    vi.useFakeTimers().setSystemTime(new Date('2026-05-11T06:00:00.000Z'));
    // Seed today's flow prices so a rebuild (if it wrongly happened) would be non-empty.
    const pricesByHour = Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [String(hour), 0.10 + hour * 0.01]),
    );
    mockHomeyInstance.settings.set(FLOW_PRICES_TODAY, {
      dateKey: '2026-05-11',
      pricesByHour,
      updatedAt: '2026-05-11T05:00:00.000Z',
    });
    const legacyV1 = {
      // No `version` field, has a `prices` array -> detected as V1.
      prices: [
        {
          startsAt: '2026-05-10T22:00:00.000Z',
          total: 0.5,
          isCheap: false,
          isExpensive: true,
        },
      ],
      avgPrice: 0.5,
      lowThreshold: 0.3,
      highThreshold: 0.7,
      priceScheme: 'flow' as const,
      priceUnit: 'øre/kWh',
      lastFetched: PRIOR_DAY_LAST_FETCHED,
    };
    mockHomeyInstance.settings.set(COMBINED_PRICES, legacyV1);

    const coordinator = createCoordinator();
    coordinator.startPriceRefresh();

    // The V1 payload is left exactly as persisted (not rebuilt into V2, not dropped).
    const stored = mockHomeyInstance.settings.get(COMBINED_PRICES) as Record<string, unknown>;
    expect(stored).toEqual(legacyV1);
    expect(stored.version).toBeUndefined();
    expect(stored.prices).toBeDefined();

    coordinator.stop();
  });

  it('does not clobber today/tomorrow prices when the boot catch-up reads empty flow slots', () => {
    // Realistic boot scenario: the cache was last fetched yesterday (so the boot catch-up is
    // eligible) but already holds TODAY's prices. The raw flow slots are missing/transiently
    // unreadable at boot, so getCombinedHourlyPrices() returns [] and the rebuilt payload is
    // empty. The data-safety guard in updateCombinedPrices must keep the populated cache rather
    // than wiping today's still-valid prices on a transient empty read.
    vi.useFakeTimers().setSystemTime(new Date('2026-05-11T06:00:00.000Z'));
    // No FLOW_PRICES_TODAY / FLOW_PRICES_TOMORROW seeded -> empty rebuild.
    const cacheWithTodayPrices = {
      version: 2 as const,
      days: {
        '2026-05-11': {
          hours: [
            {
              startsAt: '2026-05-11T00:00:00.000Z',
              total: 0.5,
              isCheap: false,
              isExpensive: true,
            },
          ],
        },
      },
      avgPrice: 0.5,
      lowThreshold: 0.3,
      highThreshold: 0.7,
      priceScheme: 'flow' as const,
      priceUnit: 'øre/kWh',
      lastFetched: PRIOR_DAY_LAST_FETCHED,
    };
    mockHomeyInstance.settings.set(COMBINED_PRICES, cacheWithTodayPrices);

    const coordinator = createCoordinator();
    coordinator.startPriceRefresh();

    // Today's prices survive intact: not replaced by the empty rebuild.
    expect(mockHomeyInstance.settings.get(COMBINED_PRICES)).toEqual(cacheWithTodayPrices);

    coordinator.stop();
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
    // Trigger the initial publish so the assertion below has something to compare against.
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
