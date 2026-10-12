import { describe, expect, it } from 'vitest';
import { isLegacySettingsKeyListed, listLegacySettingsKeys } from '../../lib/store/legacySettingsImport';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';

const withKeys = (getKeys: () => string[]): SettingsPort => ({
  get: () => null,
  set: () => {},
  unset: () => {},
  getKeys,
});

const isLegacy = (key: string): boolean => key.startsWith('legacy_');

describe('listLegacySettingsKeys', () => {
  it('answers the keys that match', () => {
    const settings = withKeys(() => ['legacy_a', 'capacity_enabled', 'legacy_b']);
    expect(listLegacySettingsKeys(settings, isLegacy)).toEqual(['legacy_a', 'legacy_b']);
    expect(listLegacySettingsKeys(settings, (key) => key === 'other')).toEqual([]);
  });

  // PELS always has settings keys: an empty list is the SDK's flake, not an
  // empty store, and concludes nothing.
  it('answers unknown for a key list that throws or comes back empty', () => {
    expect(listLegacySettingsKeys(withKeys(() => { throw new Error('sdk unavailable'); }), isLegacy)).toBeNull();
    expect(listLegacySettingsKeys(withKeys(() => []), isLegacy)).toBeNull();
  });
});

describe('isLegacySettingsKeyListed', () => {
  it('answers listed, not listed, or unknown', () => {
    expect(isLegacySettingsKeyListed(withKeys(() => ['legacy_a']), 'legacy_a')).toBe(true);
    expect(isLegacySettingsKeyListed(withKeys(() => ['capacity_enabled']), 'legacy_a')).toBe(false);
    expect(isLegacySettingsKeyListed(withKeys(() => []), 'legacy_a')).toBeNull();
  });
});
