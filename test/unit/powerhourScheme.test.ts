import {
  buildPowerhourPayloads,
  resolvePowerhourDevice,
  resolvePowerhourSourceUiStatus,
  type PowerhourCache,
  type PowerhourCachedDay,
} from '../../lib/price/powerhourScheme';
import type { FlowPricePayload } from '../../packages/shared-domain/src/price/flowPriceUtils';
import type { PowerhourDevice } from '../../lib/price/powerhourPriceFetch';
import { getFlowPricePayload } from '../../packages/shared-domain/src/price/flowPriceUtils';

const TZ = 'Europe/Oslo';
// 2026-09-20 12:00 local (Oslo is UTC+2 in September).
const NOW = new Date('2026-09-20T10:00:00.000Z');
const OSLO_MIDNIGHT = Date.UTC(2026, 8, 19, 22, 0, 0);

const hourSlots = (fromHour: number, toHour: number, price: (hour: number) => number) => (
  Array.from({ length: toHour - fromHour }, (_, index) => {
    const hour = fromHour + index;
    return {
      startsAt: new Date(OSLO_MIDNIGHT + hour * 3_600_000).toISOString(),
      importPrice: price(hour),
    };
  })
);

const device = (overrides: Partial<PowerhourDevice> = {}): PowerhourDevice => ({
  deviceId: 'no2',
  deviceName: 'NO_Norway_2',
  biddingZone: '10YNO-2--------T',
  currency: '€',
  priceIntervalMinutes: 60,
  slots: hourSlots(12, 24, (hour) => hour / 100),
  ...overrides,
});

/** A stored day, or the absence of one, in the shape the store resolves to. */
const day = (payload: FlowPricePayload | null): PowerhourCachedDay => (
  payload ? { kind: 'stored', payload } : { kind: 'absent' }
);

const cacheOf = (
  today: FlowPricePayload | null,
  tomorrow: FlowPricePayload | null,
  deviceId: string | null,
): PowerhourCache => ({
  today: day(today),
  tomorrow: day(tomorrow),
  device: deviceId ? { kind: 'device', deviceId } : { kind: 'absent' },
});

const emptyCache = (): PowerhourCache => cacheOf(null, null, null);

const chosen = (deviceId: string) => ({ kind: 'chosen' as const, deviceId });
const unchosen = { kind: 'unchosen' as const };

describe('choosing which Power by the Hour device prices the home', () => {
  const a = device({ deviceId: 'a' });
  const b = device({ deviceId: 'b' });

  it('uses the owner’s choice when it is still there', () => {
    expect(resolvePowerhourDevice([a, b], chosen('b'))).toEqual({ kind: 'selected', device: b });
  });

  // One device is not a choice: a home with a single price device should get
  // prices without first answering a question with one possible answer.
  it('uses the only device when the owner has chosen nothing', () => {
    expect(resolvePowerhourDevice([a], unchosen)).toEqual({ kind: 'selected', device: a });
  });

  // Guessing would price the home from whichever zone the app listed first.
  it('refuses to guess between two devices', () => {
    expect(resolvePowerhourDevice([a, b], unchosen)).toEqual({ kind: 'device_missing', deviceId: '' });
  });

  it('names the choice that has gone away', () => {
    expect(resolvePowerhourDevice([a, b], chosen('c'))).toEqual({ kind: 'device_missing', deviceId: 'c' });
  });

  it('reports an app with no price devices', () => {
    expect(resolvePowerhourDevice([], chosen('a'))).toEqual({ kind: 'no_devices' });
  });

  // A choice PELS could not read is not a choice the owner did not make.
  it('decides nothing when the choice could not be read', () => {
    expect(resolvePowerhourDevice([a, b], { kind: 'unreadable' })).toEqual({ kind: 'unreadable' });
  });
});

describe('mirroring one read into the stored days', () => {
  it('stores today’s slots at the device’s own period length', () => {
    const payloads = buildPowerhourPayloads(device(), emptyCache(), TZ, NOW);

    expect(payloads.today.kind).toBe('store');
    const stored = payloads.today.kind === 'store' ? payloads.today.payload : null;
    expect(stored?.dateKey).toBe('2026-09-20');
    expect(Object.keys(stored?.pricesByHour ?? {})).toHaveLength(12);
    expect(stored?.pricesByHour['12']).toBeCloseTo(0.12);
    // An hourly source publishes no finer series, so there is nothing for
    // `pricesByPeriod` to carry that `pricesBySlot` does not already say.
    expect(stored?.pricesByPeriod).toBeUndefined();
  });

  it('carries a quarter-hourly device’s own periods', () => {
    const quarters = Array.from({ length: 4 }, (_, index) => ({
      startsAt: new Date(OSLO_MIDNIGHT + 12 * 3_600_000 + index * 900_000).toISOString(),
      importPrice: (index + 1) / 100,
    }));
    const payloads = buildPowerhourPayloads(
      device({ priceIntervalMinutes: 15, slots: quarters }),
      emptyCache(),
      TZ,
      NOW,
    );

    const stored = payloads.today.kind === 'store' ? payloads.today.payload : null;
    expect(stored?.pricesByPeriod).toHaveLength(4);
    expect(stored?.pricesByPeriod?.[0]?.durationMinutes).toBe(15);
    // The hourly view an hour-shaped consumer reads is the weighted average.
    expect(stored?.pricesByHour['12']).toBeCloseTo(0.025);
  });

  it('splits slots across today and tomorrow by local day', () => {
    const tomorrow = Array.from({ length: 3 }, (_, index) => ({
      startsAt: new Date(OSLO_MIDNIGHT + (24 + index) * 3_600_000).toISOString(),
      importPrice: 1 + index,
    }));
    const payloads = buildPowerhourPayloads(
      device({ slots: [...hourSlots(12, 24, (hour) => hour / 100), ...tomorrow] }),
      emptyCache(),
      TZ,
      NOW,
    );

    expect(payloads.today.kind === 'store' && payloads.today.payload.dateKey).toBe('2026-09-20');
    expect(payloads.tomorrow.kind === 'store' && payloads.tomorrow.payload.dateKey).toBe('2026-09-21');
  });

  // The app answers from the current period onwards, so writing its answer over
  // the stored day would delete this morning's prices every refresh.
  it('merges into the stored day rather than replacing it', () => {
    const morning = buildPowerhourPayloads(
      device({ slots: hourSlots(0, 24, (hour) => hour / 100) }),
      emptyCache(),
      TZ,
      new Date(OSLO_MIDNIGHT),
    );
    const cache = cacheOf(morning.today.kind === 'store' ? morning.today.payload : null, null, 'no2');

    const afternoon = buildPowerhourPayloads(device(), cache, TZ, NOW);
    const stored = afternoon.today.kind === 'store' ? afternoon.today.payload : null;

    expect(Object.keys(stored?.pricesByHour ?? {})).toHaveLength(24);
    expect(stored?.pricesByHour['3']).toBeCloseTo(0.03);
  });

  it('lets a revised price win over the one already stored', () => {
    const first = buildPowerhourPayloads(device(), emptyCache(), TZ, NOW);
    const cache = cacheOf(first.today.kind === 'store' ? first.today.payload : null, null, 'no2');

    const revised = buildPowerhourPayloads(
      device({ slots: hourSlots(12, 24, () => 9) }),
      cache,
      TZ,
      NOW,
    );
    const stored = revised.today.kind === 'store' ? revised.today.payload : null;
    expect(stored?.pricesByHour['12']).toBe(9);
  });

  // Two devices are two bidding zones; a day half-priced in each reads as one
  // series and is nothing of the sort.
  it('drops the stored day when it came from another device', () => {
    const other = buildPowerhourPayloads(
      device({ deviceId: 'no1', slots: hourSlots(0, 24, () => 5) }),
      emptyCache(),
      TZ,
      new Date(OSLO_MIDNIGHT),
    );
    const cache = cacheOf(other.today.kind === 'store' ? other.today.payload : null, null, 'no1');

    const payloads = buildPowerhourPayloads(device(), cache, TZ, NOW);
    const stored = payloads.today.kind === 'store' ? payloads.today.payload : null;
    expect(Object.keys(stored?.pricesByHour ?? {})).toHaveLength(12);
    expect(stored?.pricesByHour['3']).toBeUndefined();
  });

  // ...and a day the new device has nothing to say about yet must not keep the
  // old device's prices either.
  it('clears a day that still holds the previous device’s prices', () => {
    const cache = cacheOf(
      null,
      { dateKey: '2026-09-21', pricesByHour: { 0: 5 }, updatedAt: NOW.toISOString() },
      'no1',
    );
    const payloads = buildPowerhourPayloads(device(), cache, TZ, NOW);
    expect(payloads.tomorrow).toEqual({ kind: 'clear' });
  });

  // On the SAME device an absent day is an absent reading, and an absent
  // reading is a no-op.
  it('keeps a day the same device has no slots for', () => {
    const cache = cacheOf(null, null, 'no2');
    const payloads = buildPowerhourPayloads(device(), cache, TZ, NOW);
    expect(payloads.tomorrow).toEqual({ kind: 'keep' });
  });

  // Nothing stored means nothing to undo, whichever device wrote last.
  it('leaves an empty day alone rather than writing null over it', () => {
    const cache = cacheOf(null, null, 'no1');
    expect(buildPowerhourPayloads(device(), cache, TZ, NOW).tomorrow).toEqual({ kind: 'keep' });
  });

  // A read that did not come back is not "there was nothing there". Merging
  // against nothing and writing the result would persist the app's future-only
  // answer as the whole day and delete this morning for good.
  it('leaves a day it could not read exactly as it is', () => {
    const cache: PowerhourCache = {
      today: { kind: 'unreadable' },
      tomorrow: { kind: 'absent' },
      device: { kind: 'device', deviceId: 'no2' },
    };

    expect(buildPowerhourPayloads(device(), cache, TZ, NOW).today).toEqual({ kind: 'keep' });
  });

  // Same fact about the marker: absent or unreadable is "no verdict", and the
  // no-verdict answer is to keep the stored periods rather than drop them.
  it.each([
    ['unreadable', { kind: 'unreadable' as const }],
    ['absent', { kind: 'absent' as const }],
  ])('keeps the stored hours when the device marker is %s', (_label, marker) => {
    const morning = buildPowerhourPayloads(
      device({ slots: hourSlots(0, 24, (hour) => hour / 100) }),
      emptyCache(),
      TZ,
      new Date(OSLO_MIDNIGHT),
    );
    const cache: PowerhourCache = {
      today: day(morning.today.kind === 'store' ? morning.today.payload : null),
      tomorrow: { kind: 'absent' },
      device: marker,
    };

    const afternoon = buildPowerhourPayloads(device(), cache, TZ, NOW);
    const stored = afternoon.today.kind === 'store' ? afternoon.today.payload : null;
    expect(Object.keys(stored?.pricesByHour ?? {})).toHaveLength(24);
  });

  it('drops slots for a day neither today nor tomorrow', () => {
    const payloads = buildPowerhourPayloads(
      device({
        slots: [
          ...hourSlots(12, 24, (hour) => hour / 100),
          { startsAt: new Date(OSLO_MIDNIGHT + 50 * 3_600_000).toISOString(), importPrice: 7 },
        ],
      }),
      emptyCache(),
      TZ,
      NOW,
    );
    expect(payloads.tomorrow.kind).toBe('keep');
  });

  // Codex P1 on #2462. A day that could not be read is kept — but it is still the
  // PREVIOUS device's day. Advancing the marker would adopt it as this device's,
  // and the next merge would put two bidding zones in one day.
  it('flags a retained day that still belongs to the previous device', () => {
    const cache: PowerhourCache = {
      today: { kind: 'unreadable' },
      tomorrow: { kind: 'absent' },
      device: { kind: 'device', deviceId: 'no1' },
    };

    const payloads = buildPowerhourPayloads(device(), cache, TZ, NOW);
    expect(payloads.today).toEqual({ kind: 'keep' });
    expect(payloads.retainsForeignDay).toBe(true);
  });

  it.each([
    ['the same device', { kind: 'device' as const, deviceId: 'no2' }],
    ['no marker at all', { kind: 'absent' as const }],
  ])('does not flag an unreadable day under %s', (_label, marker) => {
    const cache: PowerhourCache = {
      today: { kind: 'unreadable' },
      tomorrow: { kind: 'absent' },
      device: marker,
    };
    expect(buildPowerhourPayloads(device(), cache, TZ, NOW).retainsForeignDay).toBe(false);
  });

  it('carries the device’s currency, and none when it states none', () => {
    expect(buildPowerhourPayloads(device(), emptyCache(), TZ, NOW).currency).toBe('€');
    expect(buildPowerhourPayloads(device({ currency: '' }), emptyCache(), TZ, NOW).currency).toBeNull();
  });

  it('writes a payload an older build can still read', () => {
    const payloads = buildPowerhourPayloads(device(), emptyCache(), TZ, NOW);
    const stored = payloads.today.kind === 'store' ? payloads.today.payload : null;
    // `pricesBySlot` has meant one entry per local hour in every version that
    // ever wrote it, so a reinstall of an older build reads the right prices.
    expect(stored?.pricesBySlot?.every((entry) => entry.durationMinutes === 60)).toBe(true);
    expect(getFlowPricePayload(stored)).not.toBeNull();
  });
});

describe('what the owner is told about the source', () => {
  it.each([
    ['not_permitted', 'not_permitted'],
    ['app_unavailable', 'app_unavailable'],
    // A running app that will not answer and an app that is not running are the
    // same problem in the same place, from the owner's side.
    ['read_failed', 'app_unavailable'],
    ['malformed', 'app_unavailable'],
  ] as const)('maps an unavailable %s read to %s', (reason, kind) => {
    expect(resolvePowerhourSourceUiStatus({ kind: 'unavailable', reason }, unchosen)).toEqual({ kind });
  });

  it('reports no devices', () => {
    expect(resolvePowerhourSourceUiStatus({ kind: 'resolved', devices: [] }, unchosen))
      .toEqual({ kind: 'no_devices' });
  });

  it('offers every device to choose from when the choice has gone away', () => {
    const status = resolvePowerhourSourceUiStatus(
      { kind: 'resolved', devices: [device({ deviceId: 'a' }), device({ deviceId: 'b' })] },
      chosen('c'),
    );
    expect(status.kind).toBe('device_missing');
    expect(status.kind === 'device_missing' && status.devices.map((d) => d.deviceId)).toEqual(['a', 'b']);
  });

  it('names the device in force, and what distinguishes it', () => {
    const status = resolvePowerhourSourceUiStatus({ kind: 'resolved', devices: [device()] }, chosen('no2'));
    expect(status).toEqual({
      kind: 'reading',
      selected: {
        deviceId: 'no2',
        deviceName: 'NO_Norway_2',
        priceIntervalMinutes: 60,
        biddingZone: '10YNO-2--------T',
      },
      devices: [{
        deviceId: 'no2',
        deviceName: 'NO_Norway_2',
        priceIntervalMinutes: 60,
        biddingZone: '10YNO-2--------T',
      }],
    });
  });
});
