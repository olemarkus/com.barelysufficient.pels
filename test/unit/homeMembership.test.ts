// Unit tests for the pure device→home membership resolver
// (`lib/home/membership.ts`): deepest-subtree-wins zone rule, pin overrides,
// visible fallback on dangling pins, and the fail-safe-to-main paths for
// unusable zone data (unknown zone, broken parent chain, parent cycle).
import { describe, expect, it } from 'vitest';
import {
  MAIN_HOME_ID,
  type SubHomeConfig,
  type ZoneTree,
} from '../../lib/home/homeConfig';
import { resolveDeviceHome } from '../../lib/home/membership';

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

// Nested roots (annex inside floor1) — validation flags this for v1, but the
// resolver must still behave deterministically: deepest subtree wins.
const floor1Home = subHome('h_floor100', 'floor1');
const annexHome = subHome('h_annex000', 'annex');
const subHomes = [floor1Home, annexHome];

const resolve = (overrides: Partial<Parameters<typeof resolveDeviceHome>[0]> = {}) => (
  resolveDeviceHome({
    zones,
    subHomes,
    pins: {},
    deviceId: 'dev-1',
    deviceZoneId: 'annexRoom',
    ...overrides,
  })
);

describe('resolveDeviceHome — zone rule', () => {
  it('picks the DEEPEST sub-home whose root subtree contains the device zone', () => {
    expect(resolve()).toEqual({ homeId: annexHome.homeId, source: 'zone' });
  });

  it('a device in a sub-home root zone itself belongs to that sub-home', () => {
    expect(resolve({ deviceZoneId: 'annex' })).toEqual({ homeId: annexHome.homeId, source: 'zone' });
  });

  it('a device between an outer root and an inner root belongs to the outer sub-home', () => {
    expect(resolve({ deviceZoneId: 'floor1' })).toEqual({ homeId: floor1Home.homeId, source: 'zone' });
  });

  it('a device outside every sub-home subtree belongs to main (the complement)', () => {
    expect(resolve({ deviceZoneId: 'garage' })).toEqual({ homeId: MAIN_HOME_ID, source: 'zone' });
  });

  it('with no sub-homes configured everything is main', () => {
    expect(resolve({ subHomes: [] })).toEqual({ homeId: MAIN_HOME_ID, source: 'zone' });
  });

  it('duplicate root zones resolve to the first sub-home in config order', () => {
    const twin = subHome('h_twin0000', 'annex');
    expect(resolve({ subHomes: [annexHome, twin] })).toEqual({ homeId: annexHome.homeId, source: 'zone' });
  });
});

describe('resolveDeviceHome — pins', () => {
  it('an explicit pin overrides the zone rule', () => {
    expect(resolve({ pins: { 'dev-1': floor1Home.homeId } }))
      .toEqual({ homeId: floor1Home.homeId, source: 'pin' });
  });

  it('a pin to main opts a device out of a surrounding sub-home', () => {
    expect(resolve({ pins: { 'dev-1': MAIN_HOME_ID } }))
      .toEqual({ homeId: MAIN_HOME_ID, source: 'pin' });
  });

  it('another device\'s pin does not apply', () => {
    expect(resolve({ pins: { 'dev-2': floor1Home.homeId } }))
      .toEqual({ homeId: annexHome.homeId, source: 'zone' });
  });

  it('a pin to a nonexistent home falls back to the zone rule, visibly', () => {
    expect(resolve({ pins: { 'dev-1': 'h_ghost000' } }))
      .toEqual({ homeId: annexHome.homeId, source: 'fallback' });
  });

  it('a dangling pin with unusable zone data fail-safes to main, visibly', () => {
    expect(resolve({ pins: { 'dev-1': 'h_ghost000' }, deviceZoneId: 'nowhere' }))
      .toEqual({ homeId: MAIN_HOME_ID, source: 'fallback' });
  });
});

describe('resolveDeviceHome — fail-safe on unusable zone data', () => {
  it('an unknown device zone resolves to main', () => {
    expect(resolve({ deviceZoneId: 'nowhere' })).toEqual({ homeId: MAIN_HOME_ID, source: 'fallback' });
  });

  it('a missing (null) device zone resolves to main', () => {
    expect(resolve({ deviceZoneId: null })).toEqual({ homeId: MAIN_HOME_ID, source: 'fallback' });
  });

  it('a broken parent chain resolves to main', () => {
    const broken: ZoneTree = { orphan: zone('orphan', 'missing') };
    expect(resolve({ zones: broken, subHomes: [subHome('h_any00000', 'orphan')], deviceZoneId: 'orphan' }))
      .toEqual({ homeId: MAIN_HOME_ID, source: 'fallback' });
  });

  it('a parent cycle resolves to main', () => {
    const cyclic: ZoneTree = { a: zone('a', 'b'), b: zone('b', 'a') };
    expect(resolve({ zones: cyclic, subHomes: [subHome('h_any00000', 'a')], deviceZoneId: 'a' }))
      .toEqual({ homeId: MAIN_HOME_ID, source: 'fallback' });
  });
});
