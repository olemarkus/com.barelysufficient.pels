import { ModePriorityCatalog, readModePriorityCatalog } from '../../packages/shared-domain/src/settings/modePriorities';
import {
  normalizeModePriorities,
  normalizeModePriorityMap,
  rankActiveDevicePriorities,
} from '../../packages/shared-domain/src/modePriorities';

describe('normalizeModePriorityMap', () => {
  it('assigns unique, gap-free ranks 1..N to a loaded set of devices', () => {
    const result = normalizeModePriorityMap({ a: 1, b: 2, c: 3 });
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
    // The contract every consumer relies on: no two devices share a rank.
    const ranks = Object.values(result);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect([...ranks].sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  it('closes gaps in the stored ordering', () => {
    // Stored priorities 10/40/90 → contiguous 1/2/3 preserving relative order.
    expect(normalizeModePriorityMap({ a: 10, b: 40, c: 90 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('breaks ties deterministically by deviceId ascending', () => {
    // b and a both stored as 5; a wins because its id sorts first.
    expect(normalizeModePriorityMap({ b: 5, a: 5, c: 2 })).toEqual({ c: 1, a: 2, b: 3 });
  });

  it('produces the same order regardless of stored key order', () => {
    const one = normalizeModePriorityMap({ a: 5, b: 5, c: 5 });
    const two = normalizeModePriorityMap({ c: 5, b: 5, a: 5 });
    expect(one).toEqual(two);
    expect(one).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('sorts non-finite or missing priorities last, then by deviceId', () => {
    const result = normalizeModePriorityMap({
      good: 1,
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      missing: undefined as unknown as number,
    });
    expect(result.good).toBe(1);
    // The three invalid entries fill 2..4, ordered by deviceId.
    expect(result).toEqual({ good: 1, infinite: 2, missing: 3, nan: 4 });
  });

  it('is idempotent — normalizing already-strict data is a no-op', () => {
    const once = normalizeModePriorityMap({ b: 5, a: 5, c: 2 });
    const twice = normalizeModePriorityMap(once);
    expect(twice).toEqual(once);
  });

  it('returns an empty map for empty or non-object input', () => {
    expect(normalizeModePriorityMap({})).toEqual({});
    expect(normalizeModePriorityMap(null)).toEqual({});
    expect(normalizeModePriorityMap(undefined)).toEqual({});
  });
});

describe('normalizeModePriorities', () => {
  it('normalizes every mode independently', () => {
    const result = normalizeModePriorities({
      Home: { a: 7, b: 7 },
      Away: { x: 3, y: 1, z: 1 },
    });
    expect(result).toEqual({
      Home: { a: 1, b: 2 },
      Away: { y: 1, z: 2, x: 3 },
    });
  });

  it('preserves modes with no devices so mode existence is not lost', () => {
    expect(normalizeModePriorities({ Home: {}, Away: { a: 1 } })).toEqual({
      Home: {},
      Away: { a: 1 },
    });
  });

  it('returns an empty object for empty or non-object input', () => {
    expect(normalizeModePriorities({})).toEqual({});
    expect(normalizeModePriorities(null)).toEqual({});
    expect(normalizeModePriorities(undefined)).toEqual({});
  });
});

describe('rankActiveDevicePriorities', () => {
  it('projects the active device set to unique, gap-free ranks', () => {
    const stored = { removed: 1, heater: 4, charger: 9 };

    expect(rankActiveDevicePriorities(
      ['charger', 'heater'],
      (deviceId) => stored[deviceId as keyof typeof stored],
    )).toEqual({ heater: 1, charger: 2 });
  });

  it('ranks unconfigured peers deterministically after configured devices', () => {
    const stored: Record<string, number> = { heater: 100 };

    expect(rankActiveDevicePriorities(
      ['z-new', 'heater', 'a-new'],
      (deviceId) => stored[deviceId],
    )).toEqual({ heater: 1, 'a-new': 2, 'z-new': 3 });
  });

  it('breaks equal and invalid priorities by device id', () => {
    const stored: Record<string, number> = {
      zulu: 5,
      alpha: 5,
      missing: Number.NaN,
    };

    expect(rankActiveDevicePriorities(
      ['zulu', 'missing', 'alpha'],
      (deviceId) => stored[deviceId],
    )).toEqual({ alpha: 1, zulu: 2, missing: 3 });
  });

  it('deduplicates repeated device ids', () => {
    expect(rankActiveDevicePriorities(
      ['heater', 'heater'],
      () => 100,
    )).toEqual({ heater: 1 });
  });
});


describe('mode priority catalog boundary', () => {
  it('does not invent a mode when reading an empty preference catalog for an edit', () => {
    const catalog = readModePriorityCatalog({});
    expect(catalog?.resolve([], [])).toEqual({});
    expect(catalog?.resolveConfiguration({}, { Away: {} }, 'Away')).toEqual({ Away: {} });
  });

  it('fills new devices and target-only modes without changing the stored preference source', () => {
    const catalog = new ModePriorityCatalog({ Home: { configured: 100 } });
    expect(catalog.resolve(['configured', 'z-new'], ['Home', 'Eco'])).toEqual({
      Home: { configured: 1, 'z-new': 2 },
      Eco: { configured: 1, 'z-new': 2 },
    });
    // Reading first must not promote z-new into a preference over a device
    // returning through the objective reservation grace roster later.
    const order = catalog.getOrder('Home', ['z-new', 'a-returned', 'configured'], () => false);
    expect(order.getPriority('configured')).toBe(1);
    expect(order.getPriority('a-returned')).toBe(2);
    expect(order.getPriority('z-new')).toBe(3);
  });

  it('ranks the current roster independently of retained ghosts and other homes', () => {
    const catalog = new ModePriorityCatalog({ Home: { ghost: 1, otherHome: 2, heater: 100 } });
    const snapshot = catalog.resolve(['new'], ['Home', 'Eco'], (id) => id !== 'otherHome');
    expect(snapshot.Home).toEqual({ ghost: 1, heater: 2, new: 3 });
    const order = catalog.getOrder('Home', ['heater', 'new'], () => false);
    expect(order.getPriority('heater')).toBe(1);
    expect(order.getPriority('new')).toBe(2);
  });

  it('completes managed and target-only configuration inside the owning home', () => {
    const catalog = new ModePriorityCatalog({ Home: { heater: 3 } });
    const managed = { heater: true, otherHome: true, disabled: false };
    const targets = { Eco: { targetOnly: 21 } };
    const membership = { getHomeIdForDevice: (id: string) => id === 'otherHome' ? 'area' : 'main' };
    expect(catalog.resolveHomeConfiguration(managed, targets, 'Home', 'main', membership)).toEqual({
      Home: { heater: 1, targetOnly: 2 },
      Eco: { heater: 1, targetOnly: 2 },
    });
    expect(catalog.resolveHomeConfiguration(managed, targets, 'Home', 'area', membership)).toEqual({
      Home: { otherHome: 1 }, Eco: { otherHome: 1 },
    });
  });

  it('rejects a malformed external catalog without publishing a partial one', () => {
    expect(readModePriorityCatalog({ Home: { heater: Number.NaN } })).toBeNull();
    expect(readModePriorityCatalog({ Home: { heater: 1 }, Broken: null })).toBeNull();
    expect(readModePriorityCatalog(null)).toBeNull();
    expect(readModePriorityCatalog(new Date())).toBeNull();
    expect(readModePriorityCatalog({ Home: new Date() })).toBeNull();
    expect(readModePriorityCatalog({ Home: ['heater'] })).toBeNull();
    expect(readModePriorityCatalog({ Home: { heater: 'first' } })).toBeNull();
  });
});

describe('ModePriorityCatalog.withMissingRanks', () => {
  it('returns null when every device is ranked in every mode', () => {
    const catalog = new ModePriorityCatalog({ Home: { a: 1, b: 2 }, Away: { b: 1, a: 2 } });
    expect(catalog.withMissingRanks(['a', 'b'], ['Home', 'Away'], () => false)).toBeNull();
  });

  it('appends unranked devices after the ranked ones, in device-id order, in every mode', () => {
    const catalog = new ModePriorityCatalog({ Home: { a: 1, b: 2 }, Away: { b: 1 } });
    expect(catalog.withMissingRanks(['d', 'c', 'a', 'b'], ['Home', 'Away'], () => false)).toEqual({
      Home: { a: 1, b: 2, c: 3, d: 4 },
      Away: { b: 1, a: 2, c: 3, d: 4 },
    });
  });

  it('keeps the existing order and adds a mode known only to the caller', () => {
    const catalog = new ModePriorityCatalog({ Home: { b: 1, a: 2 } });
    expect(catalog.withMissingRanks(['a', 'b'], ['Home', 'Night'], () => false)).toEqual({
      Home: { b: 1, a: 2 },
      Night: { a: 1, b: 2 },
    });
  });

  it('matches the order rankActiveDevicePriorities already infers for unranked devices', () => {
    const catalog = new ModePriorityCatalog({ Home: { z: 1 } });
    const persisted = catalog.withMissingRanks(['y', 'x', 'z'], ['Home'], () => false);
    expect(persisted?.Home).toEqual(rankActiveDevicePriorities(['y', 'x', 'z'], (id) => ({ z: 1 } as Record<string, number>)[id]));
  });

  it('places a new device above the bottom battery past a stale rank below it', () => {
    const isBattery = (deviceId: string) => deviceId.startsWith('battery');
    // `old-plug` is no longer managed: its rank does not mark where the batteries end.
    const catalog = new ModePriorityCatalog({ Home: { heater: 1, battery: 2, 'old-plug': 3 } });
    expect(catalog.withMissingRanks(['heater', 'charger'], ['Home'], isBattery)).toEqual({
      Home: { heater: 1, charger: 2, battery: 3, 'old-plug': 4 },
    });
  });

  it('appends after a stale rank when no battery is at the bottom', () => {
    const catalog = new ModePriorityCatalog({ Home: { heater: 1, 'old-plug': 2 } });
    expect(catalog.withMissingRanks(['heater', 'charger'], ['Home'], () => false)).toEqual({
      Home: { heater: 1, 'old-plug': 2, charger: 3 },
    });
  });
});

describe('rankActiveDevicePriorities with an unranked home battery', () => {
  const isBattery = (deviceId: string) => deviceId.startsWith('battery');

  it('ranks an unplaced battery after every other unplaced device, whatever their ids', () => {
    // 'aaa-new' sorts before 'battery-1' by id; the battery still goes last.
    expect(rankActiveDevicePriorities(['battery-1', 'heater', 'aaa-new'], () => undefined, isBattery))
      .toEqual({ 'aaa-new': 1, heater: 2, 'battery-1': 3 });
  });

  it('keeps a battery the owner placed where they placed it', () => {
    const stored: Record<string, number> = { heater: 2, 'battery-1': 1 };
    expect(rankActiveDevicePriorities(['heater', 'battery-1', 'pump'], (id) => stored[id], isBattery))
      .toEqual({ 'battery-1': 1, heater: 2, pump: 3 });
  });

  it('ranks exactly as before when no device is a battery', () => {
    const stored: Record<string, number> = { b: 1 };
    expect(rankActiveDevicePriorities(['c', 'a', 'b'], (id) => stored[id], isBattery))
      .toEqual(rankActiveDevicePriorities(['c', 'a', 'b'], (id) => stored[id]));
  });

  it('carries the tie-break through the catalog order', () => {
    const order = new ModePriorityCatalog({ Home: { heater: 1 } })
      .getOrder('Home', ['battery-1', 'heater', 'aaa-new'], isBattery);
    expect(order.getPriority('battery-1')).toBe(3);
    expect(order.getPriority('aaa-new')).toBe(2);
  });
});

describe('ModePriorityCatalog.withMissingRanks with a home battery', () => {
  const isBattery = (deviceId: string): boolean => deviceId.startsWith('battery');

  it('puts a new battery last', () => {
    const catalog = new ModePriorityCatalog({ Home: { heater: 1, tank: 2 } });
    expect(catalog.withMissingRanks(['heater', 'tank', 'battery'], [], isBattery)).toEqual({
      Home: { heater: 1, tank: 2, battery: 3 },
    });
  });

  it('inserts a new device above the battery at the bottom', () => {
    const catalog = new ModePriorityCatalog({ Home: { heater: 1, battery: 2 } });
    expect(catalog.withMissingRanks(['heater', 'battery', 'charger'], [], isBattery)).toEqual({
      Home: { heater: 1, charger: 2, battery: 3 },
    });
  });

  it('appends below a battery the owner moved up', () => {
    const catalog = new ModePriorityCatalog({ Home: { battery: 1, heater: 2 } });
    expect(catalog.withMissingRanks(['heater', 'battery', 'charger'], [], isBattery)).toEqual({
      Home: { battery: 1, heater: 2, charger: 3 },
    });
  });
});
