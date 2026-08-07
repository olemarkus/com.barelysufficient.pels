// Unit tests for the curtailment hold-state persistence boundary
// (`setup/curtailmentHoldStateAdapter.ts`): junk-tolerant read normalization
// (any malformed field ⇒ null ⇒ fresh estimator state) and best-effort writes.
// Pure over an injected settings-like object — no SDK, no clock.
import { describe, expect, it } from 'vitest';
import { createCurtailmentHoldStore } from '../../setup/curtailmentHoldStateAdapter';
import { CURTAILMENT_HOLD_STATE } from '../../lib/utils/settingsKeys';

const settingsWith = (value: unknown): { get: (key: string) => unknown; set: (key: string, v: unknown) => void } => {
  const map = new Map<string, unknown>([[CURTAILMENT_HOLD_STATE, value]]);
  return {
    get: (key) => map.get(key),
    set: (key, v) => { map.set(key, v); },
  };
};

describe('createCurtailmentHoldStore', () => {
  it('round-trips a valid state', () => {
    const settings = settingsWith(undefined);
    const store = createCurtailmentHoldStore(settings);
    const state = { holdLevel: 2, holdUntilMs: 1_750_000_000_000, importLatchUntilMs: null };
    expect(store.write(state)).toBe(true);
    expect(store.read()).toEqual({ state: 'resolved', value: state });
  });

  it.each([
    ['a non-object blob', 'garbage'],
    ['a null blob', null],
    ['a missing holdLevel', { holdUntilMs: null, importLatchUntilMs: null }],
    ['a non-integer holdLevel', { holdLevel: 1.5, holdUntilMs: null, importLatchUntilMs: null }],
    ['a negative holdLevel', { holdLevel: -1, holdUntilMs: null, importLatchUntilMs: null }],
    ['an out-of-ladder holdLevel', { holdLevel: 7, holdUntilMs: null, importLatchUntilMs: null }],
    ['a NaN holdUntilMs', { holdLevel: 1, holdUntilMs: Number.NaN, importLatchUntilMs: null }],
    ['a string holdUntilMs', { holdLevel: 1, holdUntilMs: 'soon', importLatchUntilMs: null }],
    ['a missing importLatchUntilMs field', { holdLevel: 1, holdUntilMs: null }],
    ['an Infinity importLatchUntilMs', { holdLevel: 1, holdUntilMs: null, importLatchUntilMs: Number.POSITIVE_INFINITY }],
  ])('normalizes %s to null (fresh state)', (_label, blob) => {
    expect(createCurtailmentHoldStore(settingsWith(blob)).read()).toEqual({ state: 'resolved', value: null });
  });

  it('accepts an expired timestamp (expiry is the consumer\'s comparison, not the boundary\'s)', () => {
    const state = { holdLevel: 3, holdUntilMs: 1, importLatchUntilMs: 2 };
    expect(createCurtailmentHoldStore(settingsWith(state)).read())
      .toEqual({ state: 'resolved', value: state });
  });

  describe('the armed latch', () => {
    it('round-trips an explicit true', () => {
      const state = { holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null, armed: true };
      expect(createCurtailmentHoldStore(settingsWith(state)).read())
        .toEqual({ state: 'resolved', value: state });
    });

    it('omits the field when absent — a pre-latch blob is "not proven", not armed', () => {
      // Older installs wrote the blob before this field existed. It must read as
      // NOT armed (one production sample re-earns it), never fabricated true.
      const stored = { holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null };
      expect(createCurtailmentHoldStore(settingsWith(stored)).read())
        .toEqual({ state: 'resolved', value: stored });
    });

    it('accepts an explicit false and omits the key rather than storing it', () => {
      // Pin the discriminant AND the omission — a truthiness check would pass
      // even on an unavailable read.
      const read = createCurtailmentHoldStore(
        settingsWith({ holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null, armed: false }),
      ).read();
      expect(read).toEqual({
        state: 'resolved',
        value: { holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null },
      });
    });

    it('condemns the whole blob when armed is a non-boolean', () => {
      // Same rule as every other field: junk anywhere means fresh start, never
      // a partially-trusted blob.
      const read = createCurtailmentHoldStore(
        settingsWith({ holdLevel: 0, holdUntilMs: null, importLatchUntilMs: null, armed: 'yes' }),
      ).read();
      expect(read).toEqual({ state: 'resolved', value: null });
    });
  });

  it('a throwing settings read reports UNAVAILABLE, not absent, and never throws', () => {
    // The distinction is load-bearing downstream: absence licenses a write,
    // an unavailable read forbids one — otherwise a transient failure lets a
    // blank ladder overwrite a retained one.
    const store = createCurtailmentHoldStore({
      get: () => { throw new Error('settings backend hiccup'); },
      set: () => undefined,
    });
    expect(store.read()).toEqual({ state: 'unavailable' });
  });

  it('a throwing settings write is swallowed (best-effort persistence)', () => {
    const store = createCurtailmentHoldStore({
      get: () => undefined,
      set: () => { throw new Error('settings backend hiccup'); },
    });
    // Swallowed, but REPORTED, so the caller can retry rather than assume.
    expect(store.write({ holdLevel: 1, holdUntilMs: null, importLatchUntilMs: null })).toBe(false);
  });
});
