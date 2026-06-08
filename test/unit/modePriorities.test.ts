import {
  normalizeModePriorities,
  normalizeModePriorityMap,
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
