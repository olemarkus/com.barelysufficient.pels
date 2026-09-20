import PriceService from '../../lib/price/priceService';
import type { PriceServiceLoggingSinks } from '../../lib/price/priceServiceLoggingSinks';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { mockHomeyInstance, setMockApiApp } from '../mocks/homey';
import {
  POWERHOUR_DEVICE_ID,
  POWERHOUR_PRICES_CURRENCY,
  POWERHOUR_PRICES_DEVICE,
  POWERHOUR_PRICES_TODAY,
  POWERHOUR_PRICES_TOMORROW,
  PRICE_SCHEME,
} from '../../lib/utils/settingsKeys';
import { POWERHOUR_APP_ID } from '../../lib/price/powerhourPriceFetch';
import { getDateKeyInTimeZone, getDateKeyStartMs, shiftDateKey } from '../../lib/utils/dateUtils';
import { noHomeyEnergyPrices, noHomeyWebApi } from '../helpers/homeyWebApiStub';
import type Homey from 'homey';

const sinks = (overrides: Partial<PriceServiceLoggingSinks> = {}): PriceServiceLoggingSinks => ({
  log: () => {},
  debugStructured: () => {},
  ...overrides,
});

const buildService = () => new PriceService(
  mockHomeyInstance as unknown as Homey.App['homey'],
  sinks(),
  () => 'Europe/Oslo',
  noHomeyEnergyPrices,
  createPriceDataStore(mockHomeyInstance.settings),
  () => ({}),
  noHomeyWebApi,
);

describe('Power by the Hour price service', () => {
  const timeZone = 'Europe/Oslo';
  // 14:00 local, so the app's "current period onwards" answer is a partial day.
  const fixedNow = new Date(Date.UTC(2026, 0, 19, 13, 0, 0));
  const todayKey = getDateKeyInTimeZone(fixedNow, timeZone);
  const tomorrowKey = shiftDateKey(todayKey, 1);

  /** The app's payload: hourly slots from `fromHour` to the end of `dateKey`. */
  const dapPrices = (dateKey: string, fromHour: number, price: (hour: number) => number) => {
    const dayStartMs = getDateKeyStartMs(dateKey, timeZone);
    return {
      generatedAt: new Date().toISOString(),
      prices: [{
        deviceId: 'no2-device',
        deviceName: 'NO_Norway_2',
        driverType: 'dap',
        biddingZone: '10YNO-2--------T',
        currency: '€',
        priceInterval: 60,
        slots: Array.from({ length: 24 - fromHour }, (_, index) => ({
          time: new Date(dayStartMs + (fromHour + index) * 3_600_000).toISOString(),
          importPrice: price(fromHour + index),
          exportPrice: 0,
          isForecast: false,
        })),
      }],
    };
  };

  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.api.clearRealtimeEvents();
    setMockApiApp(POWERHOUR_APP_ID, null);
    vi.useFakeTimers().setSystemTime(fixedNow);
    mockHomeyInstance.settings.set(PRICE_SCHEME, 'powerhour');
  });

  afterEach(() => {
    setMockApiApp(POWERHOUR_APP_ID, null);
    vi.useRealTimers();
  });

  it('stores what the app publishes, and remembers which device it came from', async () => {
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, (hour) => hour / 100),
    });

    await buildService().refreshSpotPrices(true);

    const stored = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY) as {
      dateKey?: string; pricesByHour?: Record<string, number>;
    };
    expect(stored?.dateKey).toBe(todayKey);
    expect(stored?.pricesByHour?.['14']).toBeCloseTo(0.14);
    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_CURRENCY)).toBe('€');
    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_DEVICE)).toBe('no2-device');
  });

  it('serves the stored days to the planner as hourly prices', async () => {
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, () => 1.5),
    });

    const service = buildService();
    await service.refreshSpotPrices(true);
    const hourly = service.getCombinedHourlyPrices();

    expect(hourly).toHaveLength(10);
    expect(hourly.every((entry) => entry.totalPrice === 1.5)).toBe(true);
    // The whole cost stack is the Norwegian scheme's; this source publishes one
    // opaque total and nothing is invented to fill the rest in.
    expect(hourly[0]?.spotPriceExVat).toBeUndefined();
  });

  it('labels prices in the app’s own currency', async () => {
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, () => 1),
    });

    const service = buildService();
    await service.refreshSpotPrices(true);

    expect(service.getPriceUnitLabel()).toBe('€');
  });

  // The app answers from the current period onwards; a second refresh must not
  // delete the morning it already knows about.
  it('keeps hours the app no longer publishes', async () => {
    const service = buildService();
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 0, (hour) => hour),
    });
    await service.refreshSpotPrices(true);

    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 20, (hour) => hour),
    });
    await service.refreshSpotPrices(true);

    const stored = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY) as {
      pricesByHour?: Record<string, number>;
    };
    expect(Object.keys(stored?.pricesByHour ?? {})).toHaveLength(24);
    expect(stored?.pricesByHour?.['3']).toBe(3);
  });

  it('stores tomorrow once the app has it', async () => {
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => {
        const today = dapPrices(todayKey, 14, () => 1);
        const tomorrow = dapPrices(tomorrowKey, 0, () => 2);
        const [todayDevice] = today.prices;
        const [tomorrowDevice] = tomorrow.prices;
        return {
          generatedAt: today.generatedAt,
          prices: [{
            ...todayDevice,
            slots: [...(todayDevice?.slots ?? []), ...(tomorrowDevice?.slots ?? [])],
          }],
        };
      },
    });

    await buildService().refreshSpotPrices(true);

    const stored = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TOMORROW) as { dateKey?: string };
    expect(stored?.dateKey).toBe(tomorrowKey);
  });

  // The app answers from the current period onwards, and only the ROTATION
  // moves a `tomorrow` payload that has become today into the today slot. Boot
  // after local midnight without rotating first and the merge base is dated
  // yesterday: today is written as the app's future-only answer, and the
  // rotation later in the series build then clears the copy of today that still
  // held the elapsed hours.
  it('keeps the elapsed hours across a local-day rollover', async () => {
    const nightKey = shiftDateKey(todayKey, -1);
    const fullDay = (dateKey: string) => ({
      dateKey,
      pricesByHour: Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [String(hour), hour])),
      updatedAt: fixedNow.toISOString(),
    });
    // Yesterday in the today slot, and today's full day still in tomorrow's —
    // exactly what a home that has not rotated since midnight holds.
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TODAY, fullDay(nightKey));
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TOMORROW, fullDay(todayKey));
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_DEVICE, 'no2-device');
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, (hour) => hour),
    });

    await buildService().refreshSpotPrices(true);

    const stored = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY) as {
      dateKey?: string; pricesByHour?: Record<string, number>;
    };
    expect(stored?.dateKey).toBe(todayKey);
    expect(Object.keys(stored?.pricesByHour ?? {})).toHaveLength(24);
    expect(stored?.pricesByHour?.['3']).toBe(3);
  });

  // The app is installed and running; the route itself failed. Nothing about
  // that says the stored days are wrong.
  it('leaves the stored days untouched when the route rejects', async () => {
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, () => 1),
    });
    const service = buildService();
    await service.refreshSpotPrices(true);
    const before = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY);

    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => { throw new Error('route gone'); },
    });
    await service.refreshSpotPrices(true);

    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY)).toEqual(before);
    expect(service.getPowerhourSourceUiStatus()).toEqual({ kind: 'app_unavailable' });
  });

  // "No device in force" and "priced from a device the owner has stopped using"
  // cannot both be true; the settings page says the first, so the cache goes.
  it('drops the previous device’s days once no device is in force', async () => {
    mockHomeyInstance.settings.set(POWERHOUR_DEVICE_ID, 'no2-device');
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, () => 1),
    });
    const service = buildService();
    await service.refreshSpotPrices(true);
    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY)).toBeTruthy();

    // The owner's device is gone from the app, and another is in its place.
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => {
        const payload = dapPrices(todayKey, 14, () => 1);
        const [first] = payload.prices;
        return { ...payload, prices: [{ ...first, deviceId: 'no1-device' }] };
      },
    });
    await service.refreshSpotPrices(true);

    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY)).toBeFalsy();
    expect(service.getCombinedHourlyPrices()).toEqual([]);
  });

  // Regression, found on the SHS test Homey: clearing a day by STORING null left
  // the key listed, the next read called it `unreadable`, and the source never
  // stored that day again — the home stayed unpriced for good.
  it('prices the home again after the device is changed', async () => {
    mockHomeyInstance.settings.set(POWERHOUR_DEVICE_ID, 'no2-device');
    const twoDevices = async () => {
      const payload = dapPrices(todayKey, 14, () => 1);
      const [first] = payload.prices;
      return {
        ...payload,
        prices: [first, { ...first, deviceId: 'no1-device', deviceName: 'NO_Norway_1' }],
      };
    };
    setMockApiApp(POWERHOUR_APP_ID, { installed: true, get: twoDevices });
    const service = buildService();
    await service.refreshSpotPrices(true);
    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY)).toBeTruthy();

    // The owner un-chooses: the previous device's days are dropped.
    mockHomeyInstance.settings.set(POWERHOUR_DEVICE_ID, '');
    await service.refreshSpotPrices(true);
    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY)).toBeFalsy();
    // ...and the key is GONE, not stored as null — a listed-but-empty key is how
    // a transient miss is recognised, and this was a deliberate clear.
    expect(mockHomeyInstance.settings.getKeys()).not.toContain(POWERHOUR_PRICES_TODAY);

    // They pick the other one; prices must come back.
    mockHomeyInstance.settings.set(POWERHOUR_DEVICE_ID, 'no1-device');
    await service.refreshSpotPrices(true);

    const stored = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY) as { dateKey?: string };
    expect(stored?.dateKey).toBe(todayKey);
    expect(service.getCombinedHourlyPrices().length).toBeGreaterThan(0);
  });

  // The state an older build could leave behind: the key LISTED with a `null`
  // value. `null` is what the SDK answers for an unset key, so it is absence —
  // reading it as a failed read made the source refuse to write for good.
  it('stores over a day left behind as a stored null', async () => {
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TODAY, null);
    expect(mockHomeyInstance.settings.getKeys()).toContain(POWERHOUR_PRICES_TODAY);
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, () => 1),
    });

    await buildService().refreshSpotPrices(true);

    const stored = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY) as { dateKey?: string };
    expect(stored?.dateKey).toBe(todayKey);
  });

  // Codex P1 on #2462. With today stale and the tomorrow slot unreadable, a pass
  // that writes anything is fatal: it puts this device's future-only answer in
  // the today slot, and the NEXT pass — seeing today as current — clears the
  // tomorrow copy that still held the elapsed hours. So the pass decides nothing.
  it('keeps the elapsed hours when a stored day cannot be read', async () => {
    const nightKey = shiftDateKey(todayKey, -1);
    const fullDay = (dateKey: string) => ({
      dateKey,
      pricesByHour: Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [String(hour), hour])),
      updatedAt: fixedNow.toISOString(),
    });
    const wholeToday = fullDay(todayKey);
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TODAY, fullDay(nightKey));
    // Listed, but this read does not produce it — the transient the guard is for.
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TOMORROW, undefined);
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_DEVICE, 'no2-device');
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, (hour) => hour),
    });
    const service = buildService();

    await service.refreshSpotPrices(true);

    // Nothing was written while the cache could not be read.
    const afterBlind = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY) as { dateKey?: string };
    expect(afterBlind?.dateKey).toBe(nightKey);

    // The read recovers, with the full copy of today where it always was.
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TOMORROW, wholeToday);
    await service.refreshSpotPrices(true);

    const today = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY) as {
      dateKey?: string; pricesByHour?: Record<string, number>;
    };
    expect(today?.dateKey).toBe(todayKey);
    expect(Object.keys(today?.pricesByHour ?? {})).toHaveLength(24);
    expect(today?.pricesByHour?.['3']).toBe(3);
  });

  // Codex P2 on #2462: the stored unit must name the device in force.
  it('drops the previous device’s currency when the new one states none', async () => {
    mockHomeyInstance.settings.set(POWERHOUR_DEVICE_ID, 'no2-device');
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, () => 1),
    });
    const service = buildService();
    await service.refreshSpotPrices(true);
    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_CURRENCY)).toBe('€');

    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => {
        const payload = dapPrices(todayKey, 14, () => 1);
        const [first] = payload.prices;
        return { ...payload, prices: [{ ...first, currency: '' }] };
      },
    });
    await service.refreshSpotPrices(true);

    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_CURRENCY)).toBeFalsy();
    // ...and the label falls back to the modelled unknown, not the stale unit.
    expect(service.getPriceUnitLabel()).toBe('price units');
  });

  // Codex P1 on #2462. A retained day still belongs to the PREVIOUS device, so
  // the marker must not advance past it — otherwise the next merge takes that
  // day for this device's own cache and mixes two bidding zones into one day.
  it('holds the device marker while a previous device’s day is unreadable', async () => {
    const stale = {
      dateKey: todayKey,
      pricesByHour: { 0: 99, 1: 99 },
      updatedAt: fixedNow.toISOString(),
    };
    mockHomeyInstance.settings.set(POWERHOUR_DEVICE_ID, 'no2-device');
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_DEVICE, 'no1-device');
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TODAY, undefined);
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TOMORROW, stale);
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, () => 1),
    });
    const service = buildService();

    await service.refreshSpotPrices(true);
    // The pass decided nothing (today unreadable), so the marker still names the
    // device that actually wrote what is stored.
    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_DEVICE)).toBe('no1-device');

    // Today becomes readable and is plainly the other device's. It must be
    // dropped, not merged, and only then may the marker move.
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TODAY, stale);
    await service.refreshSpotPrices(true);

    const today = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY) as {
      pricesByHour?: Record<string, number>;
    };
    expect(today?.pricesByHour?.['0']).toBeUndefined();
    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_DEVICE)).toBe('no2-device');
  });

  it('reports no status at all off this price source', async () => {
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => dapPrices(todayKey, 14, () => 1),
    });
    const service = buildService();
    await service.refreshSpotPrices(true);
    expect(service.getPowerhourSourceUiStatus().kind).toBe('reading');

    mockHomeyInstance.settings.set(PRICE_SCHEME, 'norway');
    expect(service.getPowerhourSourceUiStatus()).toEqual({ kind: 'unknown' });
  });

  it('writes nothing when the app is not installed', async () => {
    setMockApiApp(POWERHOUR_APP_ID, { installed: false, get: async () => ({ prices: [] }) });
    mockHomeyInstance.settings.set(POWERHOUR_PRICES_TODAY, {
      dateKey: todayKey, pricesByHour: { 14: 9 }, updatedAt: fixedNow.toISOString(),
    });

    const service = buildService();
    await service.refreshSpotPrices(true);

    const stored = mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY) as {
      pricesByHour?: Record<string, number>;
    };
    expect(stored?.pricesByHour?.['14']).toBe(9);
    expect(service.getPowerhourSourceUiStatus()).toEqual({ kind: 'app_unavailable' });
  });

  // An unregistered app is how the mock spells "no permission", which is what a
  // Cloud Homey and a missing app permission both look like.
  it('reports a refused handle without throwing', async () => {
    const service = buildService();
    await expect(service.refreshSpotPrices(true)).resolves.toBeUndefined();
    expect(service.getPowerhourSourceUiStatus()).toEqual({ kind: 'not_permitted' });
  });

  it('waits for the owner to choose between two price devices', async () => {
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => {
        const payload = dapPrices(todayKey, 14, () => 1);
        const [first] = payload.prices;
        return {
          ...payload,
          prices: [first, { ...first, deviceId: 'no1-device', deviceName: 'NO_Norway_1' }],
        };
      },
    });

    const service = buildService();
    await service.refreshSpotPrices(true);

    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_TODAY)).toBeFalsy();
    const status = service.getPowerhourSourceUiStatus();
    expect(status.kind).toBe('device_missing');
    expect(status.kind === 'device_missing' && status.devices).toHaveLength(2);
  });

  it('prices from the device the owner chose', async () => {
    mockHomeyInstance.settings.set(POWERHOUR_DEVICE_ID, 'no1-device');
    setMockApiApp(POWERHOUR_APP_ID, {
      installed: true,
      get: async () => {
        const payload = dapPrices(todayKey, 14, () => 1);
        const [first] = payload.prices;
        return {
          ...payload,
          prices: [
            first,
            {
              ...first,
              deviceId: 'no1-device',
              deviceName: 'NO_Norway_1',
              slots: (first?.slots ?? []).map((s) => ({ ...s, importPrice: 7 })),
            },
          ],
        };
      },
    });

    const service = buildService();
    await service.refreshSpotPrices(true);

    expect(service.getCombinedHourlyPrices()[0]?.totalPrice).toBe(7);
    expect(mockHomeyInstance.settings.get(POWERHOUR_PRICES_DEVICE)).toBe('no1-device');
  });
});
