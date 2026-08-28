import { describe, expect, it } from 'vitest';
import {
  isWritableModeDeviceTargets,
  sanitizeModeDeviceTargets,
} from '../../packages/shared-domain/src/settings/modeDeviceTargets';

describe('sanitizeModeDeviceTargets', () => {
  it('keeps a well-formed catalog unchanged', () => {
    expect(sanitizeModeDeviceTargets({ Home: { h1: 21 }, Away: { h1: 16 } }))
      .toEqual({ Home: { h1: 21 }, Away: { h1: 16 } });
  });

  it('keeps a malformed mode as an empty one rather than dropping the key', () => {
    // The key is the only record that the owner configured this mode. Dropping
    // it deletes the mode on the next write; the value it carried held nothing.
    expect(sanitizeModeDeviceTargets({ Home: { h1: 21 }, Away: null }))
      .toEqual({ Home: { h1: 21 }, Away: {} });
  });

  it('keeps the mode for every shape a value can be malformed in', () => {
    expect(sanitizeModeDeviceTargets({ a: 5, b: 'x', c: [], d: undefined }))
      .toEqual({ a: {}, b: {}, c: {}, d: {} });
  });

  it('drops a junk entry without poisoning its neighbours', () => {
    expect(sanitizeModeDeviceTargets({ Home: { good: 21, bad: '21', nan: Number.NaN } }))
      .toEqual({ Home: { good: 21 } });
  });

  it('reports no catalog at all when the blob is not an object', () => {
    // The caller decides whether that means "never written" or "read failed" —
    // the runtime can cross-check `getKeys()`, the settings UI cannot.
    [null, undefined, 42, 'x', []].forEach((value) => {
      expect(sanitizeModeDeviceTargets(value)).toBeNull();
    });
  });
});

describe('isWritableModeDeviceTargets', () => {
  it('accepts a well-formed catalog, including an empty mode', () => {
    expect(isWritableModeDeviceTargets({ Home: { h1: 21 }, Away: {} })).toBe(true);
    expect(isWritableModeDeviceTargets({})).toBe(true);
  });

  it('refuses what the reader would have had to repair', () => {
    // The reader tolerates these because the store may already hold them. A
    // writer is choosing the bytes, so it must not be where they come from.
    expect(isWritableModeDeviceTargets({ Home: { h1: 21 }, Away: null })).toBe(false);
    expect(isWritableModeDeviceTargets({ Home: { h1: '21' } })).toBe(false);
    expect(isWritableModeDeviceTargets({ Home: { h1: Number.NaN } })).toBe(false);
    expect(isWritableModeDeviceTargets({ Home: [] })).toBe(false);
    expect(isWritableModeDeviceTargets(null)).toBe(false);
  });
});
