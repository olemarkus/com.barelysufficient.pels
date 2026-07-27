// Unit tests for the multi-home config boundary (`lib/home/homeConfig.ts`):
// normalization of the untrusted persisted blobs (drop malformed entries, keep
// good ones), the v1 nested-root validation, the zone ancestry walk, and the
// homeId generator. Pure — randomness is pinned via a node:crypto module mock.
import { describe, expect, it, vi } from 'vitest';
import {
  MAIN_HOME_ID,
  findMainMeterCollision,
  findNestedSubHomeRoots,
  generateHomeId,
  isPlausibleDeviceHomeAssignmentsBlob,
  isPlausibleHomesConfigBlob,
  isValidSubHomeId,
  normalizeDeviceHomeAssignments,
  normalizeHomesConfig,
  resolveExplicitMainMeterDeviceId,
  zoneAncestryPath,
  type SubHomeConfig,
  type ZoneTree,
} from '../../lib/home/homeConfig';

const uuidQueue: string[] = [];
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomUUID: typeof actual.randomUUID = () => (
    (uuidQueue.shift() ?? actual.randomUUID()) as ReturnType<typeof actual.randomUUID>
  );
  return { ...actual, randomUUID };
});

const zone = (id: string, parent: string | null): ZoneTree[string] => ({ id, name: id, parent });

// house ─┬─ floor1 ── annex ── annexRoom
//        └─ garage
const zones: ZoneTree = {
  house: zone('house', null),
  floor1: zone('floor1', 'house'),
  annex: zone('annex', 'floor1'),
  annexRoom: zone('annexRoom', 'annex'),
  garage: zone('garage', 'house'),
};

const subHome = (homeId: string, rootZoneId: string): SubHomeConfig => ({
  homeId, name: homeId, rootZoneId, meterDeviceId: null,
});

describe('normalizeHomesConfig', () => {
  it.each([
    ['a string blob', 'garbage'],
    ['a null blob', null],
    ['a number blob', 7],
    ['a record without subHomes', { unrelated: true }],
    ['a non-array subHomes', { subHomes: 'nope' }],
  ])('normalizes %s to an empty config', (_label, blob) => {
    expect(normalizeHomesConfig(blob)).toEqual({ subHomes: [] });
  });

  it('keeps well-formed entries and drops malformed ones', () => {
    const good = { homeId: 'h_aaaa1111', name: 'Annex', rootZoneId: 'annex', meterDeviceId: 'meter-1' };
    const noMeter = { homeId: 'h_bbbb2222', name: '', rootZoneId: 'garage' };
    const normalized = normalizeHomesConfig({
      subHomes: [
        good,
        noMeter,
        'not-a-record',
        { name: 'missing id', rootZoneId: 'annex' },
        { homeId: '', name: 'empty id', rootZoneId: 'annex' },
        { homeId: 'bad:id', name: 'colon id', rootZoneId: 'annex' },
        { homeId: MAIN_HOME_ID, name: 'reserved id', rootZoneId: 'annex' },
        { homeId: 'h_cccc3333', name: 42, rootZoneId: 'annex' },
        { homeId: 'h_dddd4444', name: 'missing root' },
        { homeId: 'h_eeee5555', name: 'empty root', rootZoneId: '' },
        { homeId: '__proto__', name: 'dangerous id', rootZoneId: 'annex' },
      ],
    });
    expect(normalized).toEqual({
      subHomes: [
        good,
        { homeId: 'h_bbbb2222', name: '', rootZoneId: 'garage', meterDeviceId: null },
      ],
    });
  });

  it('resolves a malformed meterDeviceId to null (absence, never a fabricated id)', () => {
    const normalized = normalizeHomesConfig({
      subHomes: [{ homeId: 'h_aaaa1111', name: 'Annex', rootZoneId: 'annex', meterDeviceId: 42 }],
    });
    expect(normalized.subHomes[0].meterDeviceId).toBeNull();
  });

  it('de-duplicates homeIds first-wins', () => {
    const normalized = normalizeHomesConfig({
      subHomes: [subHome('h_aaaa1111', 'annex'), subHome('h_aaaa1111', 'garage')],
    });
    expect(normalized.subHomes).toEqual([subHome('h_aaaa1111', 'annex')]);
  });
});

describe('explicit Main meter ownership', () => {
  const meteredHome: SubHomeConfig = {
    homeId: 'h_aaaa1111',
    name: 'Annex',
    rootZoneId: 'annex',
    meterDeviceId: 'meter-annex',
  };

  it('normalizes the external setting before identity checks', () => {
    expect(resolveExplicitMainMeterDeviceId('  meter-annex  ')).toBe('meter-annex');
    expect(resolveExplicitMainMeterDeviceId('   ')).toBeNull();
    expect(resolveExplicitMainMeterDeviceId(42)).toBeNull();
    expect(resolveExplicitMainMeterDeviceId('automatic')).toBeNull();
    expect(resolveExplicitMainMeterDeviceId('meter|annex')).toBeNull();
  });

  it('finds only an explicit meter that a sub-home already owns', () => {
    expect(findMainMeterCollision('meter-annex', [meteredHome])).toBe(meteredHome);
    expect(findMainMeterCollision('meter-main', [meteredHome])).toBeNull();
    expect(findMainMeterCollision(null, [meteredHome])).toBeNull();
  });
});

describe('normalizeDeviceHomeAssignments', () => {
  it.each([
    ['a string blob', 'garbage'],
    ['a null blob', null],
    ['an array blob', ['h_aaaa1111']],
  ])('normalizes %s to an empty record', (_label, blob) => {
    expect(normalizeDeviceHomeAssignments(blob)).toEqual({});
  });

  it('keeps well-formed pins (including main and pins to since-deleted homes) and drops junk', () => {
    expect(normalizeDeviceHomeAssignments({
      'dev-1': MAIN_HOME_ID,
      'dev-2': 'h_aaaa1111',
      'dev-3': 'h_ghost999', // well-formed pin to a nonexistent home stays — resolver surfaces the fallback
      'dev-4': 42,
      'dev-5': 'bad:id',
      'dev-6': '',
      'dev-7': null,
    })).toEqual({
      'dev-1': MAIN_HOME_ID,
      'dev-2': 'h_aaaa1111',
      'dev-3': 'h_ghost999',
    });
  });

  it('drops Object.prototype-colliding keys and never pollutes the prototype', () => {
    // JSON.parse creates '__proto__' as an OWN key (an object literal would set
    // the prototype instead) — this is the shape a persisted/attacker blob has.
    const malicious: unknown = JSON.parse(
      '{"__proto__": "main", "constructor": "main", "prototype": "h_aaaa1111", "dev-1": "main"}',
    );
    const normalized = normalizeDeviceHomeAssignments(malicious);
    expect(Object.keys(normalized)).toEqual(['dev-1']);
    expect(normalized['dev-1']).toBe(MAIN_HOME_ID);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(normalized, '__proto__')).toBe(false);
  });
});

describe('isPlausibleHomesConfigBlob (store-boundary, stricter than the normalizer)', () => {
  const goodEntry = { homeId: 'h_aaaa1111', name: 'Annex', rootZoneId: 'annex', meterDeviceId: null };

  it.each([
    ['an empty config', { subHomes: [] }, true],
    ['a fully well-formed config', { subHomes: [goodEntry] }, true],
    ['an entry without a meter field', { subHomes: [{ homeId: 'h_bbbb2222', name: '', rootZoneId: 'garage' }] }, true],
    ['a string blob', 'garbage', false],
    ['null', null, false],
    ['an array blob', [goodEntry], false],
    ['a record without subHomes', {}, false],
    ['a non-array subHomes', { subHomes: 'nope' }, false],
    ['a junk entry among good ones', { subHomes: [goodEntry, 'junk'] }, false],
    ['a colon homeId', { subHomes: [{ ...goodEntry, homeId: 'bad:id' }] }, false],
    ['the reserved main homeId', { subHomes: [{ ...goodEntry, homeId: MAIN_HOME_ID }] }, false],
    ['a lossily-coercible meterDeviceId', { subHomes: [{ ...goodEntry, meterDeviceId: 42 }] }, false],
    ['duplicate homeIds', { subHomes: [goodEntry, { ...goodEntry, rootZoneId: 'garage' }] }, false],
    ['duplicate assigned meters', {
      subHomes: [
        { ...goodEntry, meterDeviceId: 'meter-1' },
        {
          ...goodEntry,
          homeId: 'h_bbbb2222',
          rootZoneId: 'garage',
          meterDeviceId: 'meter-1',
        },
      ],
    }, false],
    ['multiple unassigned meters', {
      subHomes: [
        goodEntry,
        { ...goodEntry, homeId: 'h_bbbb2222', rootZoneId: 'garage' },
      ],
    }, true],
  ])('judges %s as %s', (_label, blob, plausible) => {
    expect(isPlausibleHomesConfigBlob(blob)).toBe(plausible);
  });
});

describe('isPlausibleDeviceHomeAssignmentsBlob (store-boundary, stricter than the normalizer)', () => {
  it.each([
    ['an empty record', {}, true],
    ['well-formed pins (main + sub-home shaped)', { 'dev-1': MAIN_HOME_ID, 'dev-2': 'h_aaaa1111' }, true],
    ['a string blob', 'garbage', false],
    ['null', null, false],
    ['an array blob', ['h_aaaa1111'], false],
    ['a non-string pin among good ones', { 'dev-1': MAIN_HOME_ID, 'dev-2': 42 }, false],
    ['a colon pin', { 'dev-1': 'bad:id' }, false],
    ['a dangerous __proto__ device key', JSON.parse('{"__proto__": "main"}') as unknown, false],
    ['a dangerous constructor device key', { constructor: 'main' }, false],
  ])('judges %s as %s', (_label, blob, plausible) => {
    expect(isPlausibleDeviceHomeAssignmentsBlob(blob)).toBe(plausible);
  });
});

describe('zoneAncestryPath', () => {
  it('walks leaf-first up to the root', () => {
    expect(zoneAncestryPath(zones, 'annexRoom')).toEqual(['annexRoom', 'annex', 'floor1', 'house']);
  });

  it('returns null for an unknown zone', () => {
    expect(zoneAncestryPath(zones, 'nowhere')).toBeNull();
  });

  it('returns null on a broken parent chain', () => {
    const broken: ZoneTree = { orphan: zone('orphan', 'missing') };
    expect(zoneAncestryPath(broken, 'orphan')).toBeNull();
  });

  it('returns null on a parent cycle', () => {
    const cyclic: ZoneTree = { a: zone('a', 'b'), b: zone('b', 'a') };
    expect(zoneAncestryPath(cyclic, 'a')).toBeNull();
  });

  it('a 20k-zone chain ending in a self-loop fails safe (null), never a stack overflow', () => {
    const depth = 20_000;
    const deep: ZoneTree = Object.fromEntries(
      Array.from({ length: depth }, (_, index) => [
        `z${index}`,
        zone(`z${index}`, index === depth - 1 ? `z${index}` : `z${index + 1}`),
      ]),
    );
    expect(zoneAncestryPath(deep, 'z0')).toBeNull();
  });
});

describe('findNestedSubHomeRoots', () => {
  it('flags nothing for disjoint root subtrees', () => {
    const config = { subHomes: [subHome('h_annex000', 'annex'), subHome('h_garage00', 'garage')] };
    expect(findNestedSubHomeRoots(config, zones)).toEqual([]);
  });

  it('flags a nested root regardless of config order', () => {
    const config = { subHomes: [subHome('h_annex000', 'annex'), subHome('h_floor100', 'floor1')] };
    expect(findNestedSubHomeRoots(config, zones)).toEqual([
      { outerHomeId: 'h_floor100', innerHomeId: 'h_annex000' },
    ]);
  });

  it('flags identical roots exactly once, config-order outer first', () => {
    const config = { subHomes: [subHome('h_first000', 'annex'), subHome('h_second00', 'annex')] };
    expect(findNestedSubHomeRoots(config, zones)).toEqual([
      { outerHomeId: 'h_first000', innerHomeId: 'h_second00' },
    ]);
  });

  it('never flags on broken zone data (fail-safe belongs to the resolver)', () => {
    const broken: ZoneTree = { orphan: zone('orphan', 'missing') };
    const config = { subHomes: [subHome('h_orphan00', 'orphan'), subHome('h_ghost000', 'nowhere')] };
    expect(findNestedSubHomeRoots(config, broken)).toEqual([]);
  });
});

describe('isValidSubHomeId', () => {
  it.each([
    ['an empty id', '', false],
    ['the main sentinel', MAIN_HOME_ID, false],
    ['a colon id', 'a:b', false],
    ['the __proto__ key', '__proto__', false],
    ['the constructor key', 'constructor', false],
    ['the prototype key', 'prototype', false],
    ['a generated-style id', 'h_3f9a1c2e', true],
  ])('judges %s as %s', (_label, value, valid) => {
    expect(isValidSubHomeId(value)).toBe(valid);
  });
});

describe('generateHomeId', () => {
  it('produces a short valid id (h_ + 8 hex chars, no colon, never main)', () => {
    const id = generateHomeId([]);
    expect(id).toMatch(/^h_[0-9a-f]{8}$/);
    expect(isValidSubHomeId(id)).toBe(true);
  });

  it('retries past a collision with an existing id', () => {
    uuidQueue.push('deadbeef-0000-4000-8000-000000000000', 'cafef00d-0000-4000-8000-000000000000');
    expect(generateHomeId(['h_deadbeef'])).toBe('h_cafef00d');
  });

  it('falls back to a full UUID when every short attempt collides', () => {
    const colliding = Array.from({ length: 32 }, () => 'deadbeef-0000-4000-8000-000000000000');
    const fallback = 'cafef00d-1111-4111-8111-111111111111';
    uuidQueue.push(...colliding, fallback);
    expect(generateHomeId(['h_deadbeef'])).toBe(`h_${fallback}`);
  });
});
