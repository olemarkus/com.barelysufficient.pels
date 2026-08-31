// Integration coverage for zone identity at the transport boundary:
// - `zoneId` stamped on parsed device snapshots from BOTH raw `device.zone`
//   shapes (the local Web API's zone-id STRING and the homey-api-style
//   `{ id, name }` object), with boundary validation (junk → flat undefined)
//   and label (`zone`) behavior identity.
// - `fetchZoneTree` riding the snapshot-refresh cycle: normalization drops
//   malformed entries; a failed fetch retains the cached tree AND the device
//   snapshot (abandon-grace).
// Drives the real transport parse + refresh pipeline; only the Homey SDK REST
// seam is mocked, via the shared homey mock (`setMockZones` / MockDriver).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Homey from 'homey';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import {
  MockDevice,
  MockDriver,
  mockHomeyInstance,
  setMockDrivers,
  setMockZones,
} from '../mocks/homey';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';

const homeyMock = mockHomeyInstance as unknown as Homey.App;
const noop = (): void => undefined;
const loggerMock: Logger = {
  log: noop,
  debug: noop,
  error: noop,
  structuredLog: { info: noop, error: noop, debug: noop, warn: noop } as unknown as Logger['structuredLog'],
};

const heaterDevice = (overrides: Partial<HomeyDeviceLike>): HomeyDeviceLike => ({
  id: 'dev1',
  name: 'Heater',
  class: 'heater',
  capabilities: ['measure_power', 'onoff'],
  capabilitiesObj: {
    measure_power: { value: 1000, id: 'measure_power' },
    onoff: { value: true, id: 'onoff' },
  } as HomeyDeviceLike['capabilitiesObj'],
  ...overrides,
});

beforeEach(() => {
  setMockZones({});
  setMockDrivers({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('zoneId on parsed device snapshots', () => {
  const parseOne = (overrides: Partial<HomeyDeviceLike>) => {
    const transport = new DeviceTransport(homeyMock, loggerMock);
    const [parsed] = transport.parseDeviceListForTests([heaterDevice(overrides)]);
    expect(parsed).toBeDefined();
    return parsed;
  };

  it('sources zoneId from the zone-id STRING shape (local Web API payload)', () => {
    const parsed = parseOne({ zone: 'zone-uuid-1' });
    expect(parsed.zoneId).toBe('zone-uuid-1');
    // Label behavior identity: a string zone still resolves as the label.
    expect(parsed.zone).toBe('zone-uuid-1');
  });

  it('sources zoneId from the object shape via zone.id, label from zone.name', () => {
    const parsed = parseOne({ zone: { id: 'zone-uuid-2', name: 'Living room' } });
    expect(parsed.zoneId).toBe('zone-uuid-2');
    expect(parsed.zone).toBe('Living room');
  });

  it('resolves flat undefined when zone is absent (label falls back to zoneName)', () => {
    const parsed = parseOne({ zoneName: 'Kitchen' });
    expect(parsed.zoneId).toBeUndefined();
    expect(parsed.zone).toBe('Kitchen');
  });

  it('resolves flat undefined for malformed zone values (boundary validation)', () => {
    expect(parseOne({ zone: '' }).zoneId).toBeUndefined();
    expect(parseOne({ zone: {} }).zoneId).toBeUndefined();
    expect(parseOne({ zone: { name: 'Loft' } }).zoneId).toBeUndefined();
    // Untrusted payload can carry a non-string id — must not cross the boundary.
    expect(parseOne({ zone: { id: 42 } as unknown as HomeyDeviceLike['zone'] }).zoneId).toBeUndefined();
  });
});

describe('zone tree fetch riding the snapshot refresh', () => {
  // The zone-tree refresh is deliberately DETACHED from the refreshSnapshot
  // promise (fire-and-forget at the tail of the cycle) so a degraded zones
  // read can never stall refresh callers. Against the mock REST route the
  // detached chain is microtask-only, so yielding one macrotask turn settles
  // it deterministically before the assertions read the cache.
  const settleDetachedZoneFetches = async (): Promise<void> => (
    new Promise((resolve) => { setImmediate(resolve); })
  );

  const refreshAndSettleZones = async (transport: DeviceTransport): Promise<void> => {
    await transport.refreshSnapshot({ mainMeterSelection: { state: 'unavailable' } });
    await settleDetachedZoneFetches();
  };

  it('is null before any refresh', () => {
    const transport = new DeviceTransport(homeyMock, loggerMock);
    expect(transport.getZoneTree()).toBeNull();
  });

  it('a throwing failure-path logger cannot reject the detached refresh (whole-body containment)', async () => {
    // `refreshZoneTreeCache` runs fire-and-forget; anything that throws on a
    // failure path — here `fetchZoneTree`'s own `zone_tree_fetch_failed`
    // debug call — would become an unhandled rejection without the
    // whole-body guard (vitest fails the run on one, so this test completing
    // IS the assertion).
    const explodingLogger: Logger = {
      ...loggerMock,
      debug: (...args: unknown[]) => {
        const payload = args[0] as { event?: string } | undefined;
        if (payload?.event === 'zone_tree_fetch_failed') {
          throw new Error('failure-path logger exploded');
        }
      },
    };
    setMockZones({ z1: { id: 'z1', name: 'Home', parent: null } });
    const transport = new DeviceTransport(homeyMock, explodingLogger);
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({ z1: { id: 'z1', name: 'Home', parent: null } });

    // Route now throws → fetch-failure path → the logger throws → the outer
    // containment swallows it. Cached tree retained (abandon-grace).
    setMockZones(null);
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({ z1: { id: 'z1', name: 'Home', parent: null } });
  });

  it('normalizes a good payload into the typed tree', async () => {
    setMockZones({
      z1: { id: 'z1', name: 'Home', parent: null },
      z2: { id: 'z2', name: 'First floor', parent: 'z1' },
    });
    const transport = new DeviceTransport(homeyMock, loggerMock);
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({
      z1: { id: 'z1', name: 'Home', parent: null },
      z2: { id: 'z2', name: 'First floor', parent: 'z1' },
    });
  });

  it('drops malformed entries and keeps the valid ones', async () => {
    setMockZones({
      z1: { id: 'z1', name: 'Home', parent: null },
      noId: { name: 'No id here' },
      junkString: 'not-a-zone-object',
      numberName: { id: 'z3', name: 7 },
      junkParent: { id: 'z4', name: 'Kids', parent: 99 },
      // A prototype-machinery key as parent is the same lookup hazard as a
      // dangerous id — dropped, not reparented.
      dangerousParent: { id: 'z6', name: 'Cellar', parent: '__proto__' },
      // Missing parent normalizes to null (root), not a drop.
      noParent: { id: 'z5', name: 'Garage' },
    });
    const transport = new DeviceTransport(homeyMock, loggerMock);
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({
      z1: { id: 'z1', name: 'Home', parent: null },
      z5: { id: 'z5', name: 'Garage', parent: null },
    });
  });

  it('a failed fetch leaves the cached tree AND the device snapshot untouched', async () => {
    setMockDrivers({
      driverA: new MockDriver('driverA', [new MockDevice('dev1', 'Heater', ['target_temperature', 'onoff'])]),
    });
    setMockZones({ z1: { id: 'z1', name: 'Home', parent: null } });
    const transport = new DeviceTransport(homeyMock, loggerMock);
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({ z1: { id: 'z1', name: 'Home', parent: null } });
    expect(transport.getSnapshot()).toHaveLength(1);

    // Route now throws — the transport must retain BOTH caches (abandon-grace).
    setMockZones(null);
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({ z1: { id: 'z1', name: 'Home', parent: null } });
    expect(transport.getSnapshot()).toHaveLength(1);
    expect(transport.getSnapshot()[0]?.id).toBe('dev1');
  });

  type ZonesPayload = Record<string, unknown>;
  type PendingZoneResponse = {
    resolve: (payload: ZonesPayload) => void;
    reject: (error: unknown) => void;
  };
  // Serve the zones route with manually-settled promises so detached fetches
  // can be completed OUT OF ORDER (or failed) deterministically.
  const captureZoneResponses = (): PendingZoneResponse[] => {
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    const pending: PendingZoneResponse[] = [];
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/zones/zone') {
        return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
      }
      return originalGet(path);
    });
    return pending;
  };

  it('an older cycle\'s slow zones response cannot overwrite a newer tree (generation guard)', async () => {
    const pendingZoneResponses = captureZoneResponses();

    const transport = new DeviceTransport(homeyMock, loggerMock);
    // Two refresh cycles, each detaching a zones fetch that stays pending.
    await refreshAndSettleZones(transport);
    await refreshAndSettleZones(transport);
    expect(pendingZoneResponses).toHaveLength(2);

    // The NEWER cycle's response lands first and commits.
    pendingZoneResponses[1]?.resolve({ z2: { id: 'z2', name: 'Newer', parent: null } });
    await settleDetachedZoneFetches();
    expect(transport.getZoneTree()).toEqual({ z2: { id: 'z2', name: 'Newer', parent: null } });

    // The OLDER cycle's response resolves LAST — superseded, silently dropped.
    pendingZoneResponses[0]?.resolve({ z1: { id: 'z1', name: 'Older', parent: null } });
    await settleDetachedZoneFetches();
    expect(transport.getZoneTree()).toEqual({ z2: { id: 'z2', name: 'Newer', parent: null } });
  });

  it('a superseded-but-fresher result still commits when the newer fetch failed', async () => {
    const pendingZoneResponses = captureZoneResponses();

    const transport = new DeviceTransport(homeyMock, loggerMock);
    // Seed a committed tree (generation 1).
    await refreshAndSettleZones(transport);
    pendingZoneResponses[0]?.resolve({ z0: { id: 'z0', name: 'Seed', parent: null } });
    await settleDetachedZoneFetches();
    expect(transport.getZoneTree()).toEqual({ z0: { id: 'z0', name: 'Seed', parent: null } });

    // Generation 2 stays pending; generation 3 FAILS (commits nothing).
    await refreshAndSettleZones(transport);
    await refreshAndSettleZones(transport);
    pendingZoneResponses[2]?.reject(new Error('zones endpoint down'));
    await settleDetachedZoneFetches();
    expect(transport.getZoneTree()).toEqual({ z0: { id: 'z0', name: 'Seed', parent: null } });

    // Generation 2's valid result resolves last: newer than the last COMMITTED
    // generation (1), so it lands even though a later fetch superseded it.
    pendingZoneResponses[1]?.resolve({ z2: { id: 'z2', name: 'Fresh', parent: null } });
    await settleDetachedZoneFetches();
    expect(transport.getZoneTree()).toEqual({ z2: { id: 'z2', name: 'Fresh', parent: null } });
  });

  it('rejects a prototype-polluting zone id; valid zones kept, prototypes untouched', async () => {
    setMockZones({
      z1: { id: 'z1', name: 'Home', parent: null },
      evil: { id: '__proto__', name: 'Evil', parent: null },
    });
    const transport = new DeviceTransport(homeyMock, loggerMock);
    await refreshAndSettleZones(transport);
    const tree = transport.getZoneTree();
    expect(tree).not.toBeNull();
    expect(Object.keys(tree!)).toEqual(['z1']);
    // No prototype leak on the returned record: a polluted tree would inherit
    // the hostile node's fields through its [[Prototype]].
    expect(tree!.name).toBeUndefined();
    // And the global Object.prototype is untouched.
    expect(({} as Record<string, unknown>).name).toBeUndefined();
  });

  it('normalizes a self-parenting zone to a root node', async () => {
    setMockZones({ z9: { id: 'z9', name: 'Loop', parent: 'z9' } });
    const transport = new DeviceTransport(homeyMock, loggerMock);
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({ z9: { id: 'z9', name: 'Loop', parent: null } });
  });

  it('an empty-but-valid zones payload counts as a failed fetch (a zone-less Homey cannot exist)', async () => {
    setMockZones({ z1: { id: 'z1', name: 'Home', parent: null } });
    const transport = new DeviceTransport(homeyMock, loggerMock);
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({ z1: { id: 'z1', name: 'Home', parent: null } });

    setMockZones({});
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({ z1: { id: 'z1', name: 'Home', parent: null } });
  });

  it('a payload where EVERY entry is malformed counts as a failed fetch (cached tree retained)', async () => {
    setMockZones({ z1: { id: 'z1', name: 'Home', parent: null } });
    const transport = new DeviceTransport(homeyMock, loggerMock);
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({ z1: { id: 'z1', name: 'Home', parent: null } });

    setMockZones({ bad1: { name: 'no id' }, bad2: 'junk' });
    await refreshAndSettleZones(transport);
    expect(transport.getZoneTree()).toEqual({ z1: { id: 'z1', name: 'Home', parent: null } });
  });
});
