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

  it('answers unknown for a key list that throws, and none for an empty store', () => {
    expect(listLegacySettingsKeys(withKeys(() => { throw new Error('sdk unavailable'); }), isLegacy)).toBeNull();
    expect(listLegacySettingsKeys(withKeys(() => []), isLegacy)).toEqual([]);
  });
});

describe('isLegacySettingsKeyListed', () => {
  it('answers listed, not listed, or unknown', () => {
    expect(isLegacySettingsKeyListed(withKeys(() => ['legacy_a']), 'legacy_a')).toBe(true);
    expect(isLegacySettingsKeyListed(withKeys(() => ['capacity_enabled']), 'legacy_a')).toBe(false);
    expect(isLegacySettingsKeyListed(withKeys(() => []), 'legacy_a')).toBe(false);
    expect(isLegacySettingsKeyListed(withKeys(() => { throw new Error('sdk unavailable'); }), 'legacy_a')).toBeNull();
  });
});
