// Integration tests for the multi-home settings adapter
// (`setup/homeRegistryAdapter.ts`) over the shared mock Homey SDK: the
// written-before-marker read classification (unwritten / present / suspect —
// the wipe-hazard guard for read-modify-write flows), the marker lifecycle
// (first write sets it, plausible pre-marker blobs backfill it), and
// round-trips of both keys.
import { beforeEach, describe, expect, it } from 'vitest';
import type Homey from 'homey';
import { mockHomeyInstance } from '../mocks/homey';
import {
  createDeviceHomeAssignmentsStore,
  createHomesStore,
} from '../../setup/homeRegistryAdapter';
import {
  DEVICE_HOME_ASSIGNMENTS,
  DEVICE_HOME_ASSIGNMENTS_INITIALIZED,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
} from '../../lib/utils/settingsKeys';
import { HomeStoreWriteRefusedError, type HomeConfig } from '../../lib/home/homeConfig';

const homey = mockHomeyInstance as unknown as Homey.App['homey'];

// Minimal settings-backed stub whose value/marker reads throw — the transient
// SDK failure mode the classification must treat as 'suspect', never as an
// 'unwritten' that would grant write permission.
const throwingHomey = {
  settings: {
    get: (): unknown => {
      throw new Error('settings backend hiccup');
    },
    set: (): void => undefined,
  },
} as unknown as Homey.App['homey'];

beforeEach(() => {
  mockHomeyInstance.settings.clear();
});

describe('createHomesStore', () => {
  const config: HomeConfig = {
    subHomes: [
      { homeId: 'h_aaaa1111', name: 'Annex', rootZoneId: 'annex', meterDeviceId: 'meter-1' },
      { homeId: 'h_bbbb2222', name: 'Garage', rootZoneId: 'garage', meterDeviceId: null },
    ],
  };

  it('classifies nothing-persisted as unwritten (fresh install)', () => {
    expect(createHomesStore(homey).read()).toEqual({ state: 'unwritten' });
  });

  it('round-trips a config and sets the written-before marker on first write', () => {
    const store = createHomesStore(homey);
    store.write(config);
    expect(mockHomeyInstance.settings.get(HOMES_CONFIG_INITIALIZED)).toBe(true);
    expect(mockHomeyInstance.settings.get(HOMES_CONFIG) as HomeConfig).toEqual(config);
    expect(store.read()).toEqual({ state: 'present', value: config });
  });

  it('a deliberately emptied config reads present, not suspect', () => {
    const store = createHomesStore(homey);
    store.write({ subHomes: [] });
    expect(store.read()).toEqual({ state: 'present', value: { subHomes: [] } });
  });

  it('classifies an absent blob with the marker set as suspect (transient SDK miss, not fresh)', () => {
    mockHomeyInstance.settings.set(HOMES_CONFIG_INITIALIZED, true);
    expect(createHomesStore(homey).read()).toEqual({ state: 'suspect' });
  });

  it.each([
    ['with the marker', true],
    ['without the marker', false],
  ])('classifies a junk blob as suspect %s', (_label, markerSet) => {
    if (markerSet) mockHomeyInstance.settings.set(HOMES_CONFIG_INITIALIZED, true);
    mockHomeyInstance.settings.set(HOMES_CONFIG, 'garbage');
    expect(createHomesStore(homey).read()).toEqual({ state: 'suspect' });
  });

  it('classifies entry-level corruption as suspect, never a quietly-shrunken config', () => {
    mockHomeyInstance.settings.set(HOMES_CONFIG_INITIALIZED, true);
    mockHomeyInstance.settings.set(HOMES_CONFIG, {
      subHomes: [config.subHomes[0], { homeId: 'bad:id', name: 'colon', rootZoneId: 'annex' }],
    });
    expect(createHomesStore(homey).read()).toEqual({ state: 'suspect' });
  });

  it('backfills a missing marker on reading a plausible blob (pre-marker write / manual PUT)', () => {
    mockHomeyInstance.settings.set(HOMES_CONFIG, config);
    expect(createHomesStore(homey).read()).toEqual({ state: 'present', value: config });
    expect(mockHomeyInstance.settings.get(HOMES_CONFIG_INITIALIZED)).toBe(true);
  });

  it('classifies a throwing settings read as suspect, never unwritten', () => {
    expect(createHomesStore(throwingHomey).read()).toEqual({ state: 'suspect' });
  });

  it('a malformed marker value counts as marker-present (absent blob → suspect, not unwritten)', () => {
    mockHomeyInstance.settings.set(HOMES_CONFIG_INITIALIZED, 'yes');
    expect(createHomesStore(homey).read()).toEqual({ state: 'suspect' });
  });

  it('a blob with a throwing accessor classifies suspect (boundary insurance)', () => {
    mockHomeyInstance.settings.set(HOMES_CONFIG, {
      get subHomes(): unknown {
        throw new Error('hostile accessor');
      },
    });
    expect(createHomesStore(homey).read()).toEqual({ state: 'suspect' });
  });

  it('write surfaces a marker-write failure before touching the value (marker-first ordering)', () => {
    const values = new Map<string, unknown>();
    const markerFailingHomey = {
      settings: {
        get: (key: string): unknown => values.get(key),
        set: (key: string, value: unknown): void => {
          if (key === HOMES_CONFIG_INITIALIZED) throw new Error('marker write failed');
          values.set(key, value);
        },
      },
    } as unknown as Homey.App['homey'];
    expect(() => createHomesStore(markerFailingHomey).write({ subHomes: [] }))
      .toThrow('marker write failed');
    // Marker-first: the value key was never written, so no marker-less value
    // can later read 'unwritten' and re-open the wipe window.
    expect(values.has(HOMES_CONFIG)).toBe(false);
  });

  it('a value-write failure after the marker leaves the store suspect, never unwritten', () => {
    const values = new Map<string, unknown>();
    const valueFailingHomey = {
      settings: {
        get: (key: string): unknown => values.get(key),
        set: (key: string, value: unknown): void => {
          if (key === HOMES_CONFIG) throw new Error('value write failed');
          values.set(key, value);
        },
      },
    } as unknown as Homey.App['homey'];
    const store = createHomesStore(valueFailingHomey);
    expect(() => store.write({ subHomes: [] })).toThrow('value write failed');
    expect(values.get(HOMES_CONFIG_INITIALIZED)).toBe(true);
    // The failed write's aftermath fails conservative: marker present + absent
    // value classifies suspect — the safe direction, not a wipe-window.
    expect(store.read()).toEqual({ state: 'suspect' });
  });

  it('write refuses an implausible config (typed throw) and persists nothing', () => {
    const store = createHomesStore(homey);
    const invalid: HomeConfig = {
      subHomes: [{ homeId: 'main', name: 'Reserved', rootZoneId: 'annex', meterDeviceId: null }],
    };
    expect(() => store.write(invalid)).toThrow(HomeStoreWriteRefusedError);
    expect(mockHomeyInstance.settings.get(HOMES_CONFIG)).toBeUndefined();
    expect(mockHomeyInstance.settings.get(HOMES_CONFIG_INITIALIZED)).toBeUndefined();
  });
});

describe('createDeviceHomeAssignmentsStore', () => {
  const assignments = { 'dev-1': 'main', 'dev-2': 'h_aaaa1111' };

  it('classifies nothing-persisted as unwritten (fresh install)', () => {
    expect(createDeviceHomeAssignmentsStore(homey).read()).toEqual({ state: 'unwritten' });
  });

  it('round-trips assignments and sets the written-before marker on first write', () => {
    const store = createDeviceHomeAssignmentsStore(homey);
    store.write(assignments);
    expect(mockHomeyInstance.settings.get(DEVICE_HOME_ASSIGNMENTS_INITIALIZED)).toBe(true);
    expect(mockHomeyInstance.settings.get(DEVICE_HOME_ASSIGNMENTS) as Record<string, string>)
      .toEqual(assignments);
    expect(store.read()).toEqual({ state: 'present', value: assignments });
  });

  it('a well-formed pin to a since-deleted home stays present (resolver surfaces the fallback)', () => {
    const store = createDeviceHomeAssignmentsStore(homey);
    store.write({ 'dev-1': 'h_ghost000' });
    expect(store.read()).toEqual({ state: 'present', value: { 'dev-1': 'h_ghost000' } });
  });

  it('classifies an absent blob with the marker set as suspect (transient SDK miss, not fresh)', () => {
    mockHomeyInstance.settings.set(DEVICE_HOME_ASSIGNMENTS_INITIALIZED, true);
    expect(createDeviceHomeAssignmentsStore(homey).read()).toEqual({ state: 'suspect' });
  });

  it.each([
    ['an array blob', ['h_aaaa1111']],
    ['a string blob', 'garbage'],
    ['a record with a malformed pin', { 'dev-1': 'main', 'dev-2': 42 }],
  ])('classifies %s as suspect (junk, regardless of marker)', (_label, blob) => {
    mockHomeyInstance.settings.set(DEVICE_HOME_ASSIGNMENTS, blob);
    expect(createDeviceHomeAssignmentsStore(homey).read()).toEqual({ state: 'suspect' });
  });

  it('classifies a throwing settings read as suspect, never unwritten', () => {
    expect(createDeviceHomeAssignmentsStore(throwingHomey).read()).toEqual({ state: 'suspect' });
  });

  it('write refuses an implausible pin record (typed throw) and persists nothing', () => {
    const store = createDeviceHomeAssignmentsStore(homey);
    expect(() => store.write({ 'dev-1': 'bad:id' })).toThrow(HomeStoreWriteRefusedError);
    expect(mockHomeyInstance.settings.get(DEVICE_HOME_ASSIGNMENTS)).toBeUndefined();
    expect(mockHomeyInstance.settings.get(DEVICE_HOME_ASSIGNMENTS_INITIALIZED)).toBeUndefined();
  });
});
