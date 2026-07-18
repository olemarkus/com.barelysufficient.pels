// Unit tests for the pure home→settings-key mapping helper
// (`lib/utils/settingsKeys.ts`): the main home keeps the historical unsuffixed
// key; any other home gets `<baseKey>:<homeId>`.
import { describe, expect, it } from 'vitest';
import { homeScopedSettingsKey, MAIN_HOME_ID } from '../../lib/utils/settingsKeys';

describe('homeScopedSettingsKey', () => {
  it('returns the base key unchanged for the main home', () => {
    expect(homeScopedSettingsKey('capacity_limit_kw', MAIN_HOME_ID)).toBe('capacity_limit_kw');
  });

  it('suffixes the base key with the home id for any other home', () => {
    expect(homeScopedSettingsKey('capacity_limit_kw', 'cabin')).toBe('capacity_limit_kw:cabin');
  });

  it('keeps keys of distinct homes distinct for the same base key', () => {
    const keys = [MAIN_HOME_ID, 'cabin', 'rental'].map((homeId) => homeScopedSettingsKey('capacity_dry_run', homeId));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
