import { PassThrough } from 'node:stream';
import { createHomeyDestination } from '../../lib/logging/homeyDestination';
import { createRootLogger, setRootLogger } from '../../lib/logging/logger';
import { fetchMetForecast } from '../../lib/weather/metForecast';
import { partialDouble } from '../helpers/partialDouble';

describe('MET forecast failure logs', () => {
  const log = vi.fn<(...args: unknown[]) => void>();

  beforeEach(() => {
    log.mockClear();
    setRootLogger(createRootLogger(createHomeyDestination({ log, error: vi.fn() })));
  });

  afterEach(() => {
    setRootLogger(createRootLogger(new PassThrough(), 'silent'));
  });

  const fetchForecast = (fetchImpl: typeof fetch) => fetchMetForecast({
    latitude: 59.91,
    longitude: 10.75,
    timeZone: 'Europe/Oslo',
    nowMs: Date.parse('2026-06-14T12:00:00Z'),
    userAgent: 'com.barelysufficient.pels/test (test@example.com)',
    fetchImpl,
  });

  it.each([
    new TypeError('network unavailable'),
    Object.assign(new Error('request aborted'), { name: 'AbortError' }),
    'non-Error rejection',
  ])('preserves a fetch rejection in the serialized Homey warning: %s', async (failure) => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure);

    expect(await fetchForecast(fetchImpl)).toEqual({ outcome: 'failed' });

    expect(log).toHaveBeenCalledTimes(1);
    const warning = JSON.parse(String(log.mock.calls[0][0]));
    expect(warning).toMatchObject({
      module: 'weather/metForecast',
      event: 'weather_met_forecast_fetch',
      reason: 'fetch_failed',
      err: {
        message: failure instanceof Error ? failure.message : failure,
        stack: failure instanceof Error ? failure.stack : expect.stringContaining(failure),
      },
    });
    expect(warning).not.toHaveProperty('detail');
  });

  it('preserves the HTTP status when MET rejects a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(partialDouble<Awaited<ReturnType<typeof fetch>>>({
      ok: false, status: 429, statusText: 'Too Many Requests',
    }));

    expect(await fetchForecast(fetchImpl)).toEqual({ outcome: 'failed' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      event: 'weather_met_forecast_fetch', reason: 'http_error',
      status: 429, statusText: 'Too Many Requests',
    });
  });

  it('distinguishes an unusable forecast from a fetch rejection', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(partialDouble<Awaited<ReturnType<typeof fetch>>>({
      ok: true, status: 200, json: async () => ({ properties: { timeseries: [] } }),
    }));

    expect(await fetchForecast(fetchImpl)).toEqual({ outcome: 'failed' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      event: 'weather_met_forecast_fetch', reason: 'no_usable_data',
    });
  });
});
