// Integration: createPvForecastStore boot-read classification at the settings
// seam — the loaded/absent/unreadable discrimination over the written-before
// marker (`pv_forecast_state_initialized`) and the key-list cross-check, plus
// the blob+marker single-persist write. SDK weirdness (throws, null-vs-undefined
// absence, junk key lists) is pinned HERE at the adapter boundary; the
// controller only ever branches on the semantic result (AGENTS.md "Clean and
// trusted interfaces between layers").
import { describe, expect, it } from 'vitest';
import { createPvForecastStore, type PvForecastStoreSettings } from '../../setup/pvForecastStateAdapter';
import { PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED } from '../../lib/utils/settingsKeys';
import { emptyPvForecastServiceState } from '../../lib/solar/pvForecastService';

const HOUR_MS = 3_600_000;
const BASE = Date.UTC(2026, 5, 21, 10, 0, 0);
const validBlob = {
  history: { hourly: { [String(BASE)]: { kwh: 1.2, coveredMs: HOUR_MS } } },
  irradianceByHour: {},
};

/** Map-backed settings double; `getKeys` mirrors the live key list by default. */
const makeSettings = (
  overrides: Partial<PvForecastStoreSettings> = {},
): { stored: Map<string, unknown>; settings: PvForecastStoreSettings } => {
  const stored = new Map<string, unknown>();
  const settings: PvForecastStoreSettings = {
    // The real SDK answers an unset key with `null`, not `undefined`.
    get: (key) => (stored.has(key) ? stored.get(key) : null),
    set: (key, value) => { stored.set(key, value); },
    getKeys: () => [...stored.keys()],
    ...overrides,
  };
  return { stored, settings };
};

describe('createPvForecastStore boot-read classification', () => {
  it('loads a valid blob and backfills the written-before marker (pre-marker upgrade)', () => {
    const { stored, settings } = makeSettings();
    stored.set(PV_FORECAST_STATE, validBlob);
    const read = createPvForecastStore({ settings }).read();
    expect(read).toEqual({ kind: 'loaded', state: validBlob });
    // The backfill is what lets a LATER transient miss on this install be
    // recognised as one instead of a fresh install.
    expect(stored.get(PV_FORECAST_STATE_INITIALIZED)).toBe(true);
  });

  it('still loads when the marker read throws, but skips the backfill (no signal it is missing)', () => {
    const { stored, settings } = makeSettings({
      get: (key) => {
        if (key === PV_FORECAST_STATE_INITIALIZED) throw new Error('transient');
        return validBlob;
      },
    });
    expect(createPvForecastStore({ settings }).read().kind).toBe('loaded');
    expect(stored.has(PV_FORECAST_STATE_INITIALIZED)).toBe(false);
  });

  it('classifies a proven fresh install as absent: no blob, no marker, healthy key list without the key', () => {
    const { stored, settings } = makeSettings();
    stored.set('pels_status', 'something'); // a running install always has keys
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'absent' });
  });

  it('classifies marker-present + blob cleanly missing from a healthy key list as marker_only', () => {
    // The half-persist signature: the marker-first write landed, the blob
    // write never did. NOT bundled into `unreadable` — process-lifetime
    // deferral over this shape would wedge persistence permanently.
    const { stored, settings } = makeSettings();
    stored.set(PV_FORECAST_STATE_INITIALIZED, true);
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'marker_only' });
  });

  it('classifies marker-present + blob absent as unreadable when the key list still LISTS the blob', () => {
    // The key list contradicts the empty read: this is a transient miss, not a
    // half-persist — it must stay ambiguous.
    const { settings } = makeSettings({
      get: (key) => (key === PV_FORECAST_STATE_INITIALIZED ? true : null),
      getKeys: () => [PV_FORECAST_STATE, PV_FORECAST_STATE_INITIALIZED],
    });
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'unreadable', reason: 'absence_unproven' });
  });

  it('classifies marker-present + blob absent as unreadable when the key list cannot answer', () => {
    const { settings } = makeSettings({
      get: (key) => (key === PV_FORECAST_STATE_INITIALIZED ? true : null),
      getKeys: () => { throw new Error('transient'); },
    });
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'unreadable', reason: 'absence_unproven' });
  });

  it('classifies an absent blob the key list still vouches for as unreadable (pre-marker install, miss)', () => {
    // The blob key is listed but the read came back empty: an install that
    // persisted before the marker existed, hit by a transient miss.
    const { settings } = makeSettings({
      get: () => null,
      getKeys: () => [PV_FORECAST_STATE],
    });
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'unreadable', reason: 'absence_unproven' });
  });

  it('treats an empty or junk key list as proving nothing — absence stays unreadable', () => {
    const empty = makeSettings(); // nothing stored at all ⇒ empty key list
    expect(createPvForecastStore({ settings: empty.settings }).read())
      .toEqual({ kind: 'unreadable', reason: 'absence_unproven' });

    const junk = makeSettings({ getKeys: () => 'not-a-list' });
    expect(createPvForecastStore({ settings: junk.settings }).read())
      .toEqual({ kind: 'unreadable', reason: 'absence_unproven' });
  });

  it('classifies a thrown key-list read as unreadable', () => {
    const { settings } = makeSettings({ getKeys: () => { throw new Error('transient'); } });
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'unreadable', reason: 'absence_unproven' });
  });

  it('classifies a thrown marker read (with the blob absent) as unreadable', () => {
    const { settings } = makeSettings({
      get: (key) => {
        if (key === PV_FORECAST_STATE_INITIALIZED) throw new Error('transient');
        return null;
      },
      getKeys: () => ['pels_status'],
    });
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'unreadable', reason: 'absence_unproven' });
  });

  it('classifies a thrown blob read as unreadable — the adapter never throws', () => {
    const { settings } = makeSettings({
      get: (key) => {
        if (key === PV_FORECAST_STATE) throw new Error('transient');
        return null;
      },
    });
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'unreadable', reason: 'read_threw' });
  });

  it('classifies a malformed blob as unreadable — a re-read may still heal it', () => {
    const { stored, settings } = makeSettings();
    stored.set(PV_FORECAST_STATE, { history: 'junk' });
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'unreadable', reason: 'malformed' });
  });

  it('classifies a blob whose every claimed hour fails coercion as unreadable (partial corruption)', () => {
    const { stored, settings } = makeSettings();
    stored.set(PV_FORECAST_STATE, { history: { hourly: { [String(BASE)]: { kwh: 'junk' } } } });
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'unreadable', reason: 'malformed' });
  });

  it('still loads when the backfill marker WRITE throws — read() must never throw at boot', () => {
    const { settings } = makeSettings({
      get: (key) => (key === PV_FORECAST_STATE ? validBlob : null),
      set: () => { throw new Error('quota'); },
      getKeys: () => [PV_FORECAST_STATE],
    });
    expect(createPvForecastStore({ settings }).read()).toEqual({ kind: 'loaded', state: validBlob });
  });
});

describe('createPvForecastStore write', () => {
  it('writes the blob and the marker as one persist, and the marker only once per process', () => {
    const { stored, settings } = makeSettings();
    const markerWrites: unknown[] = [];
    const store = createPvForecastStore({
      settings: {
        ...settings,
        set: (key, value) => {
          if (key === PV_FORECAST_STATE_INITIALIZED) markerWrites.push(value);
          settings.set(key, value);
        },
      },
    });
    store.write(emptyPvForecastServiceState());
    store.write(emptyPvForecastServiceState());
    expect(stored.get(PV_FORECAST_STATE)).toEqual(emptyPvForecastServiceState());
    expect(stored.get(PV_FORECAST_STATE_INITIALIZED)).toBe(true);
    expect(markerWrites).toEqual([true]); // confirmed once ⇒ not rewritten
  });

  it('a marker-write failure fails the whole persist so the caller retries both', () => {
    const { stored, settings } = makeSettings({
      set: (key, value) => {
        if (key === PV_FORECAST_STATE_INITIALIZED) throw new Error('quota');
        stored.set(key, value);
      },
    });
    const store = createPvForecastStore({ settings });
    expect(() => { store.write(emptyPvForecastServiceState()); }).toThrow('quota');
    // Marker-first ordering: the failed marker means the blob was never
    // attempted, so NOTHING half-written remains — the caller keeps its state
    // dirty and the retry rewrites both keys.
    expect(stored.has(PV_FORECAST_STATE_INITIALIZED)).toBe(false);
    expect(stored.has(PV_FORECAST_STATE)).toBe(false);
  });
});
