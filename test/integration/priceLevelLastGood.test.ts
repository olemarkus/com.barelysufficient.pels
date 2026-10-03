import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceCoordinator } from '../../lib/price/priceCoordinator';
import { createPriceOptimizationSettingsStore } from '../../lib/price/priceOptimizationSettingsStore';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { createInMemoryPriceCache } from '../helpers/priceCacheForTests';
import { PriceLevel } from '../../lib/price/priceLevels';
import { mockHomeyInstance } from '../mocks/homey';
import { noHomeyWebApi } from '../helpers/homeyWebApiStub';

const createCoordinator = (): PriceCoordinator => new PriceCoordinator({
  homey: mockHomeyInstance as never,
  priceOptimizationSettingsStore: createPriceOptimizationSettingsStore(mockHomeyInstance.settings),
  priceDataStore: createPriceDataStore(mockHomeyInstance.settings, createInMemoryPriceCache()),
  getTimeZone: () => mockHomeyInstance.clock.getTimezone(),
  getPowerTracker: () => ({}),
  homeyWebApiGet: noHomeyWebApi,
  getCurrentPriceLevel: () => PriceLevel.NORMAL,
  log: () => undefined,
  debugStructured: () => undefined,
  error: () => undefined,
});

// The current-hour level is what the `price_level_is` condition and the
// status writer ask for, and its build reads a dozen settings keys. A Homey
// settings read can transiently throw; the coordinator carries the last
// resolved level forward instead of rejecting the caller.
describe('PriceCoordinator.getCurrentHourPriceLevel', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries the last resolved level through a transient read failure', () => {
    const coordinator = createCoordinator();
    const build = vi.spyOn(coordinator['priceService'], 'getCurrentHourPriceLevel')
      .mockReturnValueOnce(PriceLevel.CHEAP)
      .mockImplementationOnce(() => { throw new Error('settings unavailable'); })
      .mockReturnValueOnce(PriceLevel.EXPENSIVE);

    expect(coordinator.getCurrentHourPriceLevel()).toBe(PriceLevel.CHEAP);
    expect(coordinator.getCurrentHourPriceLevel()).toBe(PriceLevel.CHEAP);
    expect(coordinator.getCurrentHourPriceLevel()).toBe(PriceLevel.EXPENSIVE);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('answers UNKNOWN when no level has ever resolved', () => {
    const coordinator = createCoordinator();
    vi.spyOn(coordinator['priceService'], 'getCurrentHourPriceLevel')
      .mockImplementation(() => { throw new Error('settings unavailable'); });
    expect(coordinator.getCurrentHourPriceLevel()).toBe(PriceLevel.UNKNOWN);
  });
});

// The look-ahead has no last good answer: an older one describes a window that
// has since moved, so a failed build is reported, not papered over.
describe('PriceCoordinator.getPriceLevelChangesWithin', () => {
  const window = { nowMs: Date.UTC(2026, 5, 1, 8, 0, 0), horizonMs: 3 * 3600_000 };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the window through and reports the resolved levels', () => {
    const coordinator = createCoordinator();
    const build = vi.spyOn(coordinator['priceService'], 'getPriceLevelChangesWithin')
      .mockReturnValue([PriceLevel.EXPENSIVE]);

    expect(coordinator.getPriceLevelChangesWithin(window))
      .toEqual({ state: 'resolved', levels: [PriceLevel.EXPENSIVE] });
    expect(build).toHaveBeenCalledWith(window);
  });

  it('reports a failed build as unavailable, even after a good one', () => {
    const coordinator = createCoordinator();
    vi.spyOn(coordinator['priceService'], 'getPriceLevelChangesWithin')
      .mockReturnValueOnce([PriceLevel.EXPENSIVE])
      .mockImplementationOnce(() => { throw new Error('settings unavailable'); });

    expect(coordinator.getPriceLevelChangesWithin(window).state).toBe('resolved');
    expect(coordinator.getPriceLevelChangesWithin(window)).toEqual({ state: 'unavailable' });
  });
});
