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
    store.write(state);
    expect(store.read()).toEqual(state);
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
    expect(createCurtailmentHoldStore(settingsWith(blob)).read()).toBeNull();
  });

  it('accepts an expired timestamp (expiry is the consumer\'s comparison, not the boundary\'s)', () => {
    const state = { holdLevel: 3, holdUntilMs: 1, importLatchUntilMs: 2 };
    expect(createCurtailmentHoldStore(settingsWith(state)).read()).toEqual(state);
  });

  it('a throwing settings read starts fresh (null), never throws', () => {
    const store = createCurtailmentHoldStore({
      get: () => { throw new Error('settings backend hiccup'); },
      set: () => undefined,
    });
    expect(store.read()).toBeNull();
  });

  it('a throwing settings write is swallowed (best-effort persistence)', () => {
    const store = createCurtailmentHoldStore({
      get: () => undefined,
      set: () => { throw new Error('settings backend hiccup'); },
    });
    expect(() => store.write({ holdLevel: 1, holdUntilMs: null, importLatchUntilMs: null })).not.toThrow();
  });
});
