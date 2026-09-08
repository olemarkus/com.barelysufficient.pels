import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceCoordinator } from '../../lib/price/priceCoordinator';
import { createPriceOptimizationSettingsStore } from '../../lib/price/priceOptimizationSettingsStore';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { PriceLevel } from '../../lib/price/priceLevels';
import { mockHomeyInstance } from '../mocks/homey';

// The current-hour level is what the `price_level_is` condition and the
// status writer ask for, and its build reads a dozen settings keys. A Homey
// settings read can transiently throw; the coordinator carries the last
// resolved level forward instead of rejecting the caller.
describe('PriceCoordinator.getCurrentHourPriceLevel', () => {
  const createCoordinator = (): PriceCoordinator => new PriceCoordinator({
    homey: mockHomeyInstance as never,
    priceOptimizationSettingsStore: createPriceOptimizationSettingsStore(mockHomeyInstance.settings),
    priceDataStore: createPriceDataStore(mockHomeyInstance.settings),
    getTimeZone: () => mockHomeyInstance.clock.getTimezone(),
    getPowerTracker: () => ({}),
    getCurrentPriceLevel: () => PriceLevel.NORMAL,
    rebuildPlanFromCache: async () => undefined,
    log: () => undefined,
    debugStructured: () => undefined,
    error: () => undefined,
  });

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
