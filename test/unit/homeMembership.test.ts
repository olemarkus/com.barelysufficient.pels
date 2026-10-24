// Unit tests for the pure device→home membership resolver
// (`lib/home/membership.ts`): deepest-subtree-wins zone rule, pin overrides,
// visible fallback on dangling pins, the held-out arm for a zone the committed
// tree lacks while meter areas exist, and the fail-safe-to-main paths for
// unusable zone data (broken parent chain, parent cycle, no zone, no tree).
import { describe, expect, it } from 'vitest';
import {
  MAIN_HOME_ID,
  type MembershipZoneTree,
  type SubHomeConfig,
  type ZoneTree,
} from '../../lib/home/homeConfig';
import { resolveDeviceHome } from '../../lib/home/membership';

const zone = (id: string, parent: string | null): ZoneTree[string] => ({ id, name: id, parent });
const committed = (tree: ZoneTree): MembershipZoneTree => ({ kind: 'committed', tree });

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
    zones: committed(zones),
    subHomes,
    pins: {},
    deviceId: 'dev-1',
    deviceZoneId: 'annexRoom',
    ...overrides,
  })
);

describe('resolveDeviceHome — zone rule', () => {
  it('picks the DEEPEST sub-home whose root subtree contains the device zone', () => {
    expect(resolve()).toEqual({ state: 'member', homeId: annexHome.homeId, source: 'zone' });
  });

  it('a device in a sub-home root zone itself belongs to that sub-home', () => {
    expect(resolve({ deviceZoneId: 'annex' })).toEqual({ state: 'member', homeId: annexHome.homeId, source: 'zone' });
  });

  it('a device between an outer root and an inner root belongs to the outer sub-home', () => {
    expect(resolve({ deviceZoneId: 'floor1' })).toEqual({ state: 'member', homeId: floor1Home.homeId, source: 'zone' });
  });

  it('a device outside every sub-home subtree belongs to main (the complement)', () => {
    expect(resolve({ deviceZoneId: 'garage' })).toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'zone' });
  });

  it('with no sub-homes configured everything is main', () => {
    expect(resolve({ subHomes: [] })).toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'zone' });
  });

  it('duplicate root zones resolve to the first sub-home in config order', () => {
    const twin = subHome('h_twin0000', 'annex');
    expect(resolve({ subHomes: [annexHome, twin] })).toEqual({ state: 'member', homeId: annexHome.homeId, source: 'zone' });
  });
});

describe('resolveDeviceHome — pins', () => {
  it('an explicit pin overrides the zone rule', () => {
    expect(resolve({ pins: { 'dev-1': floor1Home.homeId } }))
      .toEqual({ state: 'member', homeId: floor1Home.homeId, source: 'pin' });
  });

  it('a pin to main opts a device out of a surrounding sub-home', () => {
    expect(resolve({ pins: { 'dev-1': MAIN_HOME_ID } }))
      .toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'pin' });
  });

  it('another device\'s pin does not apply', () => {
    expect(resolve({ pins: { 'dev-2': floor1Home.homeId } }))
      .toEqual({ state: 'member', homeId: annexHome.homeId, source: 'zone' });
  });

  it('a pin to a nonexistent home falls back to the zone rule, visibly', () => {
    expect(resolve({ pins: { 'dev-1': 'h_ghost000' } }))
      .toEqual({ state: 'member', homeId: annexHome.homeId, source: 'fallback' });
  });

  it('a dangling pin with unusable zone data fail-safes to main, visibly', () => {
    const broken: ZoneTree = { orphan: zone('orphan', 'missing') };
    expect(resolve({ pins: { 'dev-1': 'h_ghost000' }, zones: committed(broken), deviceZoneId: 'orphan' }))
      .toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'fallback' });
  });
});

describe('resolveDeviceHome — a zone the committed tree lacks', () => {
  it('holds the device out of every home while meter areas exist, naming the zone', () => {
    expect(resolve({ deviceZoneId: 'nowhere' })).toEqual({ state: 'held_out', zoneId: 'nowhere' });
  });

  it('holds out a device whose pin names a home that is gone, since it resolves by zone', () => {
    expect(resolve({ pins: { 'dev-1': 'h_ghost000' }, deviceZoneId: 'nowhere' }))
      .toEqual({ state: 'held_out', zoneId: 'nowhere' });
  });

  it('never holds out a device pinned to a home that exists', () => {
    expect(resolve({ pins: { 'dev-1': floor1Home.homeId }, deviceZoneId: 'nowhere' }))
      .toEqual({ state: 'member', homeId: floor1Home.homeId, source: 'pin' });
    expect(resolve({ pins: { 'dev-1': MAIN_HOME_ID }, deviceZoneId: 'nowhere' }))
      .toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'pin' });
  });

  it('reads an inherited-property zone id as a zone the tree lacks', () => {
    expect(resolve({ deviceZoneId: 'constructor' })).toEqual({ state: 'held_out', zoneId: 'constructor' });
  });

  it('resolves to main with no meter area, where every device is Main\u2019s', () => {
    expect(resolve({ subHomes: [], deviceZoneId: 'nowhere' }))
      .toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'fallback' });
  });

  it('resolves to main before any zone tree has committed', () => {
    expect(resolve({ zones: { kind: 'pending' } })).toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'fallback' });
  });
});

describe('resolveDeviceHome — fail-safe on unusable zone data', () => {

  it('a missing (null) device zone resolves to main', () => {
    expect(resolve({ deviceZoneId: null })).toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'fallback' });
  });

  it('a broken parent chain resolves to main', () => {
    const broken: ZoneTree = { orphan: zone('orphan', 'missing') };
    expect(resolve({ zones: committed(broken), subHomes: [subHome('h_any00000', 'orphan')], deviceZoneId: 'orphan' }))
      .toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'fallback' });
  });

  it('a parent cycle resolves to main', () => {
    const cyclic: ZoneTree = { a: zone('a', 'b'), b: zone('b', 'a') };
    expect(resolve({ zones: committed(cyclic), subHomes: [subHome('h_any00000', 'a')], deviceZoneId: 'a' }))
      .toEqual({ state: 'member', homeId: MAIN_HOME_ID, source: 'fallback' });
  });
});
