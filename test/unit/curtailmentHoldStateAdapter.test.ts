// Unit tests for the curtailment hold-state persistence boundary
// (`setup/curtailmentHoldStateAdapter.ts`): the three-arm read classification
// (`loaded` for a validated blob, `absent` for genuine absence or a condemned
// malformed blob, `unreadable` for a thrown or key-list-contradicted read) and
// best-effort writes. Pure over an injected settings-like object — no SDK, no
// clock.
import { describe, expect, it } from 'vitest';
import { createCurtailmentHoldStore } from '../../setup/curtailmentHoldStateAdapter';
import { CURTAILMENT_HOLD_STATE } from '../../lib/utils/settingsKeys';

type SettingsLike = {
  get: (key: string) => unknown;
  getKeys: () => string[];
  set: (key: string, v: unknown) => void;
};

// The hold key IS stored, holding `value` (which may be malformed junk).
const settingsWith = (value: unknown): SettingsLike => {
  const map = new Map<string, unknown>([[CURTAILMENT_HOLD_STATE, value]]);
  return {
    get: (key) => map.get(key),
    getKeys: () => [...map.keys()],
    set: (key, v) => { map.set(key, v); },
  };
};

// The hold key is genuinely unset; another stored key lets the key list vouch
// that the settings backend actually answered (a working, non-fresh store).
const settingsWithout = (): SettingsLike => {
  const map = new Map<string, unknown>([['unrelated_key', 1]]);
  return {
    get: (key) => map.get(key),
    getKeys: () => [...map.keys()],
    set: (key, v) => { map.set(key, v); },
  };
};

describe('createCurtailmentHoldStore', () => {
  it('round-trips a valid state', () => {
    const settings = settingsWithout();
    const store = createCurtailmentHoldStore(settings);
    const state = { holdLevel: 2, holdUntilMs: 1_750_000_000_000, importLatchUntilMs: null };
    expect(store.write(state)).toBe(true);
    expect(store.read()).toEqual({ state: 'loaded', value: state });
  });

  it.each([
    ['a non-object blob', 'garbage'],
    ['a missing holdLevel', { holdUntilMs: null, importLatchUntilMs: null }],
    ['a non-integer holdLevel', { holdLevel: 1.5, holdUntilMs: null, importLatchUntilMs: null }],
    ['a negative holdLevel', { holdLevel: -1, holdUntilMs: null, importLatchUntilMs: null }],
    ['an out-of-ladder holdLevel', { holdLevel: 7, holdUntilMs: null, importLatchUntilMs: null }],
    ['a NaN holdUntilMs', { holdLevel: 1, holdUntilMs: Number.NaN, importLatchUntilMs: null }],
    ['a string holdUntilMs', { holdLevel: 1, holdUntilMs: 'soon', importLatchUntilMs: null }],
    ['a missing importLatchUntilMs field', { holdLevel: 1, holdUntilMs: null }],
    ['an Infinity importLatchUntilMs', { holdLevel: 1, holdUntilMs: null, importLatchUntilMs: Number.POSITIVE_INFINITY }],
  ])('condemns %s to ABSENT (safe fresh start — corruption defense)', (_label, blob) => {
    expect(createCurtailmentHoldStore(settingsWith(blob)).read()).toEqual({ state: 'absent' });
  });

  it('accepts an expired timestamp (expiry is the consumer\'s comparison, not the boundary\'s)', () => {
    const state = { holdLevel: 3, holdUntilMs: 1, importLatchUntilMs: 2 };
    expect(createCurtailmentHoldStore(settingsWith(state)).read())
      .toEqual({ state: 'loaded', value: state });
  });

  describe('the armed latch', () => {
    it('round-trips an explicit true', () => {
      const state = { holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null, armed: true };
      expect(createCurtailmentHoldStore(settingsWith(state)).read())
        .toEqual({ state: 'loaded', value: state });
    });

    it('omits the field when absent — a pre-latch blob is "not proven", not armed', () => {
      // Older installs wrote the blob before this field existed. It must read as
      // NOT armed (one production sample re-earns it), never fabricated true.
      const stored = { holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null };
      expect(createCurtailmentHoldStore(settingsWith(stored)).read())
        .toEqual({ state: 'loaded', value: stored });
    });

    it('accepts an explicit false and omits the key rather than storing it', () => {
      const read = createCurtailmentHoldStore(
        settingsWith({ holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null, armed: false }),
      ).read();
      expect(read).toEqual({
        state: 'loaded',
        value: { holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null },
      });
    });

    it('condemns the whole blob when armed is a non-boolean', () => {
      // Same rule as every other field: junk anywhere means fresh start, never
      // a partially-trusted blob.
      const read = createCurtailmentHoldStore(
        settingsWith({ holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null, armed: 'yes' }),
      ).read();
      expect(read).toEqual({ state: 'absent' });
    });
  });

  describe('empty-read classification (setup/AGENTS.md: confirm absence on the key list)', () => {
    it('an unset key the key list agrees is unset reads ABSENT', () => {
      expect(createCurtailmentHoldStore(settingsWithout()).read()).toEqual({ state: 'absent' });
    });

    it('a key the list vouches for that still reads empty is UNREADABLE (transient miss)', () => {
      // The SDK answers `null` for an unset key — but this key IS listed, so an
      // empty answer is a transient miss, not absence. Classifying it absent
      // would license a blank-ladder write over the retained blob.
      expect(createCurtailmentHoldStore(settingsWith(null)).read()).toEqual({ state: 'unreadable' });
      expect(createCurtailmentHoldStore(settingsWith(undefined)).read()).toEqual({ state: 'unreadable' });
    });

    it('an empty key list cannot vouch for absence — UNREADABLE', () => {
      // A whole-list miss is a documented transient SDK failure shape; a fresh
      // install resolves on retry as soon as any key lands.
      const store = createCurtailmentHoldStore({
        get: () => undefined,
        getKeys: () => [],
        set: () => undefined,
      });
      expect(store.read()).toEqual({ state: 'unreadable' });
    });

    it.each([
      ['a string key list', 'not-an-array'],
      ['a non-string entry', [CURTAILMENT_HOLD_STATE, 7]],
    ])('classifies %s as UNREADABLE — a malformed list cannot vouch for absence', (_label, keys) => {
      const store = createCurtailmentHoldStore({
        get: () => undefined,
        getKeys: () => keys as unknown as string[],
        set: () => undefined,
      });
      expect(store.read()).toEqual({ state: 'unreadable' });
    });

    it('a throwing key-list read on an empty value is UNREADABLE, not a crash', () => {
      const store = createCurtailmentHoldStore({
        get: () => undefined,
        getKeys: () => { throw new Error('settings backend hiccup'); },
        set: () => undefined,
      });
      expect(store.read()).toEqual({ state: 'unreadable' });
    });
  });

  it('a throwing settings read reports UNREADABLE, not absent, and never throws', () => {
    // The distinction is load-bearing downstream: absence permits a write, an
    // unreadable read forbids one — otherwise a transient failure lets a blank
    // ladder overwrite a retained one.
    const store = createCurtailmentHoldStore({
      get: () => { throw new Error('settings backend hiccup'); },
      getKeys: () => [],
      set: () => undefined,
    });
    expect(store.read()).toEqual({ state: 'unreadable' });
  });

  it('a throwing settings write is swallowed (best-effort persistence)', () => {
    const store = createCurtailmentHoldStore({
      get: () => undefined,
      getKeys: () => [],
      set: () => { throw new Error('settings backend hiccup'); },
    });
    // Swallowed, but REPORTED, so the caller can retry rather than assume.
    expect(store.write({ holdLevel: 1, holdUntilMs: null, importLatchUntilMs: null })).toBe(false);
  });
});
