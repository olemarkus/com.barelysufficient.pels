import {
  DAP_PRICES_PATH,
  fetchPowerhourPrices,
  resolvePowerhourPayload,
} from '../../lib/price/powerhourPriceFetch';
import type { ApiAppPort, ApiPort } from '../../lib/ports/homeyRuntime';

const slot = (time: string, importPrice: number) => ({ time, importPrice, exportPrice: 0, isForecast: false });

const device = (overrides: Record<string, unknown> = {}) => ({
  deviceId: '10YNO-2--------T_abc123',
  deviceName: 'NO_Norway_2',
  driverType: 'dap',
  biddingZone: '10YNO-2--------T',
  currency: '€',
  priceInterval: 60,
  slots: [slot('2026-09-20T10:00:00.000Z', 0.11), slot('2026-09-20T11:00:00.000Z', 0.12)],
  ...overrides,
});

/** An `api.getApiApp` that hands back `apiApp`, or throws the way a Homey without the permission does. */
const apiWith = (apiApp: ApiAppPort | null): Pick<ApiPort, 'getApiApp'> => ({
  getApiApp: () => {
    if (!apiApp) throw new Error('No permission to use com.gruijter.powerhour');
    return apiApp;
  },
});

describe('Power by the Hour payload resolution', () => {
  it('resolves an electricity device with its slots', () => {
    const read = resolvePowerhourPayload({ generatedAt: '2026-09-20T10:00:00.000Z', prices: [device()] });

    expect(read).toEqual({
      kind: 'resolved',
      devices: [{
        deviceId: '10YNO-2--------T_abc123',
        deviceName: 'NO_Norway_2',
        biddingZone: '10YNO-2--------T',
        currency: '€',
        priceIntervalMinutes: 60,
        slots: [
          { startsAt: '2026-09-20T10:00:00.000Z', importPrice: 0.11 },
          { startsAt: '2026-09-20T11:00:00.000Z', importPrice: 0.12 },
        ],
      }],
    });
  });

  // A gas device prices per m³. Offered to the planner it would look like a
  // plausible electricity price and be entirely wrong.
  it('drops the gas driver', () => {
    const read = resolvePowerhourPayload({ prices: [device({ driverType: 'dapg' })] });
    expect(read).toEqual({ kind: 'resolved', devices: [] });
  });

  it('keeps the 15-minute driver and its interval', () => {
    const read = resolvePowerhourPayload({
      prices: [device({ driverType: 'dap15', priceInterval: 15 })],
    });
    expect(read.kind === 'resolved' && read.devices[0]?.priceIntervalMinutes).toBe(15);
  });

  // An absent price is not zero, and zero is a price the planner would act on.
  it('drops slots with no usable instant or price', () => {
    const read = resolvePowerhourPayload({
      prices: [device({
        slots: [
          slot('not-a-date', 1),
          { time: '2026-09-20T10:00:00.000Z', importPrice: null },
          { time: '2026-09-20T11:00:00.000Z' },
          slot('2026-09-20T12:00:00.000Z', 0.5),
        ],
      })],
    });
    expect(read.kind === 'resolved' && read.devices[0]?.slots).toEqual([
      { startsAt: '2026-09-20T12:00:00.000Z', importPrice: 0.5 },
    ]);
  });

  it('keeps the first of a repeated start and orders by time', () => {
    const read = resolvePowerhourPayload({
      prices: [device({
        slots: [
          slot('2026-09-20T11:00:00.000Z', 0.12),
          slot('2026-09-20T10:00:00.000Z', 0.11),
          slot('2026-09-20T10:00:00.000Z', 9.99),
        ],
      })],
    });
    expect(read.kind === 'resolved' && read.devices[0]?.slots.map((s) => s.importPrice)).toEqual([0.11, 0.12]);
  });

  it('drops a device with no usable slot, rather than offering a dead end', () => {
    const read = resolvePowerhourPayload({ prices: [device({ slots: [] })] });
    expect(read).toEqual({ kind: 'resolved', devices: [] });
  });

  it('drops a device with no interval it can be priced at', () => {
    const read = resolvePowerhourPayload({ prices: [device({ priceInterval: 0 })] });
    expect(read).toEqual({ kind: 'resolved', devices: [] });
  });

  it.each([
    ['a non-object body', 'nope'],
    ['a body with no prices array', { generatedAt: 'x' }],
    ['an array body', [device()]],
  ])('reports %s as malformed', (_label, payload) => {
    expect(resolvePowerhourPayload(payload)).toEqual({ kind: 'unavailable', reason: 'malformed' });
  });
});

describe('Power by the Hour read', () => {
  it('reports a refused handle as not permitted, without calling anything', async () => {
    await expect(fetchPowerhourPrices(apiWith(null))).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not_permitted',
    });
  });

  it('reports an app that is not running as unavailable', async () => {
    const get = vi.fn();
    const read = await fetchPowerhourPrices(apiWith({ getInstalled: async () => false, get }));

    expect(read).toEqual({ kind: 'unavailable', reason: 'app_unavailable' });
    expect(get).not.toHaveBeenCalled();
  });

  // `getInstalled` reports on the app and nothing else, so a throw from it is
  // the app being unavailable rather than a fifth state.
  it('treats a thrown install check as the app being unavailable', async () => {
    const read = await fetchPowerhourPrices(apiWith({
      getInstalled: async () => { throw new Error('gone'); },
      get: async () => ({ prices: [device()] }),
    }));
    expect(read).toEqual({ kind: 'unavailable', reason: 'app_unavailable' });
  });

  // A running app that will not answer is a transient the next refresh may fix
  // — a different fact from the app not being there.
  it('reports a thrown call as a read failure', async () => {
    const read = await fetchPowerhourPrices(apiWith({
      getInstalled: async () => true,
      get: async () => { throw new Error('boom'); },
    }));
    expect(read).toEqual({ kind: 'unavailable', reason: 'read_failed' });
  });

  it('asks the documented route and resolves what it answers', async () => {
    const get = vi.fn(async () => ({ prices: [device()] }));
    const read = await fetchPowerhourPrices(apiWith({ getInstalled: async () => true, get }));

    expect(get).toHaveBeenCalledWith(DAP_PRICES_PATH);
    expect(read.kind === 'resolved' && read.devices).toHaveLength(1);
  });
});
