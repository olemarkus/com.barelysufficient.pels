import { logDynamicElectricityPricesFromHomey } from '../lib/app/appEnergyDebug';

describe('logDynamicElectricityPricesFromHomey', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-26T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('logs when no energy API is available', async () => {
    const log = jest.fn();
    const error = jest.fn();
    await logDynamicElectricityPricesFromHomey({
      homey: { clock: { getTimezone: () => 'Europe/Oslo' } } as any,
      log,
      error,
    });
    expect(log).toHaveBeenCalledWith('Dynamic electricity prices not available from Homey SDK or HomeyAPI.');
    expect(error).not.toHaveBeenCalled();
  });

  it('uses Homey SDK energy API when available', async () => {
    const fetchDynamicElectricityPrices = jest.fn().mockResolvedValue([]);
    const log = jest.fn();
    const error = jest.fn();
    await logDynamicElectricityPricesFromHomey({
      homey: {
        api: { energy: { fetchDynamicElectricityPrices } },
        clock: { getTimezone: () => 'Europe/Oslo' },
      } as any,
      log,
      error,
    });
    expect(fetchDynamicElectricityPrices).toHaveBeenCalledWith({ date: '2026-01-26' });
    expect(log).toHaveBeenCalledWith('Fetched dynamic electricity prices from Homey.', expect.objectContaining({
      source: 'Homey SDK',
      date: '2026-01-26',
    }));
    expect(error).not.toHaveBeenCalled();
  });

  it('uses HomeyAPI energy when SDK is unavailable', async () => {
    const fetchDynamicElectricityPrices = jest.fn().mockResolvedValue([{}]);
    const log = jest.fn();
    const error = jest.fn();
    await logDynamicElectricityPricesFromHomey({
      homey: { clock: { getTimezone: () => 'Europe/Oslo' } } as any,
      deviceManager: { getHomeyApi: () => ({ energy: { fetchDynamicElectricityPrices } }) } as any,
      log,
      error,
    });
    expect(fetchDynamicElectricityPrices).toHaveBeenCalledWith({ date: '2026-01-26' });
    expect(log).toHaveBeenCalledWith('Fetched dynamic electricity prices from Homey.', expect.objectContaining({
      source: 'HomeyAPI',
    }));
    expect(error).not.toHaveBeenCalled();
  });

  it('logs errors when price fetch fails', async () => {
    const fetchDynamicElectricityPrices = jest.fn().mockRejectedValue(new Error('boom'));
    const log = jest.fn();
    const error = jest.fn();
    await logDynamicElectricityPricesFromHomey({
      homey: {
        api: { energy: { fetchDynamicElectricityPrices } },
        clock: { getTimezone: () => 'Europe/Oslo' },
      } as any,
      log,
      error,
    });
    expect(error).toHaveBeenCalledWith(
      'Failed to fetch dynamic electricity prices from Homey SDK.',
      expect.any(Error),
    );
  });
});
