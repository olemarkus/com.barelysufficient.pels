import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../lib/app/appContext';
import { WEATHER_ADVISOR_SETTINGS } from '../../lib/utils/settingsKeys';
import { createWeatherCollector } from '../../setup/appInit/createWeatherCollector';
import { HOMEY_LOCATION_API_PATH } from '../../setup/homeyLocationAdapter';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { mockHomeyInstance, setMockGeolocation } from '../mocks/homey';

const OUTDOOR_DEVICE_ID = 'weather-location-test-device';

type FakeResponse = typeof fetch extends (...args: never[]) => Promise<infer Result> ? Result : never;

const metResponse = (): FakeResponse => ({
  status: 200,
  ok: true,
  statusText: 'OK',
  headers: { get: () => null },
  json: async () => ({ properties: { timeseries: [] } }),
} as unknown as FakeResponse);

const createEnabledCollector = () => {
  mockHomeyInstance.settings.set(WEATHER_ADVISOR_SETTINGS, {
    enabled: true,
    outdoorDeviceId: OUTDOOR_DEVICE_ID,
  });
  return createWeatherCollector(createAppContextMock({
    homey: mockHomeyInstance as unknown as AppContext['homey'],
  }));
};

describe('weather location Web API wiring', () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    mockHomeyInstance.settings.clear();
    setMockGeolocation(59.91, 10.75);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the hub location through the owner API route before requesting MET', async () => {
    setMockGeolocation(60.39, 5.32);
    const apiGet = vi.spyOn(mockHomeyInstance.api, 'get');
    const fetchMock = vi.fn(async (_input: unknown) => metResponse());
    vi.stubGlobal('fetch', fetchMock);

    stop = createEnabledCollector().start();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(apiGet).toHaveBeenCalledWith(HOMEY_LOCATION_API_PATH);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('?lat=60.3900&lon=5.3200');
  });

  it.each([
    ['an absent location', () => setMockGeolocation(null, null)],
    ['a failed location read', () => {
      vi.spyOn(mockHomeyInstance.api, 'get').mockRejectedValueOnce(new Error('location unavailable'));
    }],
  ])('does not request MET for %s', async (_label, arrange) => {
    arrange();
    const apiGet = vi.spyOn(mockHomeyInstance.api, 'get');
    const fetchMock = vi.fn(async (_input: unknown) => metResponse());
    vi.stubGlobal('fetch', fetchMock);

    stop = createEnabledCollector().start();

    await vi.waitFor(() => expect(apiGet).toHaveBeenCalledWith(HOMEY_LOCATION_API_PATH));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
