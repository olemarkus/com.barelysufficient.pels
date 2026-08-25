import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSolarForecastDay } from '../../setup/homeyEnergySolarForecastAdapter';
import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import { HomeyHttpStatusError } from '../../lib/utils/homeyHttpStatusError';
import { mockHomeyInstance } from '../mocks/homey';

describe('Homey Energy solar forecast Web API adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockHomeyInstance.api._solarForecastByDate = null;
  });

  it('resolves an object body and leaves point validation to the parser', async () => {
    mockHomeyInstance.api._solarForecastByDate = {
      '2026-08-25': { resolution: 15, points: [], totalWh: null },
    };
    await expect(fetchSolarForecastDay('2026-08-25')).resolves.toEqual({
      kind: 'resolved',
      body: { resolution: 15, points: [], totalWh: null },
    });
  });

  it('classifies the route-missing rejection (pre-13.4.0 firmware) as unavailable', async () => {
    // _solarForecastByDate stays null ⇒ the mock rejects with the same typed
    // HomeyHttpStatusError(404) the real transport produces for the pre-13.4.0
    // HTML "Cannot GET" answer.
    await expect(fetchSolarForecastDay('2026-08-25')).resolves.toEqual({ kind: 'unavailable' });
  });

  it('classifies a no-forecast-basis 404 (date with no entry) as unavailable', async () => {
    mockHomeyInstance.api._solarForecastByDate = {};
    await expect(fetchSolarForecastDay('2026-08-25')).resolves.toEqual({ kind: 'unavailable' });
  });

  it('classifies a malformed 200 body (HTML login page) as transient failed, never unavailable', async () => {
    // The transport talking, not Homey saying it has no forecast: classifying
    // it as definitive would clear the day's last-good series on one flaky read.
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValueOnce('<html>login</html>');
    await expect(fetchSolarForecastDay('2026-08-25')).resolves.toEqual({ kind: 'failed' });
  });

  it('classifies timeouts, 5xx, and network failures as transient failed', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockRejectedValueOnce(
      new HomeyRequestTimeoutError('GET', '/api/manager/energy/forecast/solar'),
    );
    await expect(fetchSolarForecastDay('2026-08-25')).resolves.toEqual({ kind: 'failed' });

    vi.spyOn(mockHomeyInstance.api, 'get').mockRejectedValueOnce(new HomeyHttpStatusError(500, 'internal'));
    await expect(fetchSolarForecastDay('2026-08-25')).resolves.toEqual({ kind: 'failed' });

    vi.spyOn(mockHomeyInstance.api, 'get').mockRejectedValueOnce(new Error('socket hang up'));
    await expect(fetchSolarForecastDay('2026-08-25')).resolves.toEqual({ kind: 'failed' });
  });

  it('classifies non-404 4xx (token hiccup, throttling) as transient failed, never unavailable', async () => {
    // A 401/403/429 is not a statement about the forecast — treating it as
    // definitive would clear last-good state on one flaky read.
    for (const statusCode of [401, 403, 429]) {
      vi.spyOn(mockHomeyInstance.api, 'get').mockRejectedValueOnce(
        new HomeyHttpStatusError(statusCode, 'transient'),
      );
      await expect(fetchSolarForecastDay('2026-08-25')).resolves.toEqual({ kind: 'failed' });
    }
  });
});
