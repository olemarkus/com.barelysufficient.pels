// Unit tests for the pure home→settings-key mapping helpers
// (`lib/utils/settingsKeys.ts`): the main home keeps the historical unsuffixed
// key; any other home gets `<baseKey>:<homeId>`. The inverse parse is total —
// anything that is not a well-formed non-main scoped key of a scopable base
// resolves to an ordinary exact key on the main home.
import { describe, expect, it } from 'vitest';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  homeScopedSettingsKey,
  isHomeScopableBaseKey,
  MAIN_HOME_ID,
  parseHomeScopedSettingsKey,
  POWER_TRACKER_STATE,
} from '../../lib/utils/settingsKeys';

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

describe('parseHomeScopedSettingsKey', () => {
  const scopableBases = [
    CAPACITY_LIMIT_KW,
    CAPACITY_MARGIN_KW,
    CAPACITY_DRY_RUN,
    POWER_TRACKER_STATE,
  ];

  it.each(scopableBases)('round-trips %s through homeScopedSettingsKey for a non-main home', (baseKey) => {
    const key = homeScopedSettingsKey(baseKey, 'cabin');
    expect(parseHomeScopedSettingsKey(key)).toEqual({ baseKey, homeId: 'cabin' });
  });

  it('round-trips the main home to the unsuffixed exact key', () => {
    const key = homeScopedSettingsKey(CAPACITY_LIMIT_KW, MAIN_HOME_ID);
    expect(key).toBe(CAPACITY_LIMIT_KW);
    expect(parseHomeScopedSettingsKey(key)).toEqual({
      baseKey: CAPACITY_LIMIT_KW,
      homeId: MAIN_HOME_ID,
    });
  });

  it('round-trips a home id that itself contains a colon', () => {
    const key = homeScopedSettingsKey(POWER_TRACKER_STATE, 'cabin:west');
    expect(parseHomeScopedSettingsKey(key)).toEqual({
      baseKey: POWER_TRACKER_STATE,
      homeId: 'cabin:west',
    });
  });

  it('treats a colon key with a non-scopable base as an ordinary exact key', () => {
    expect(parseHomeScopedSettingsKey('foo:bar')).toEqual({
      baseKey: 'foo:bar',
      homeId: MAIN_HOME_ID,
    });
  });

  it('treats an empty home suffix as an ordinary exact key', () => {
    expect(parseHomeScopedSettingsKey(`${CAPACITY_LIMIT_KW}:`)).toEqual({
      baseKey: `${CAPACITY_LIMIT_KW}:`,
      homeId: MAIN_HOME_ID,
    });
  });

  it('treats an explicit main-home suffix as an ordinary exact key, never an alias of the main key', () => {
    // The forward helper never produces `<base>:main`; parsing it as the main
    // key would create a second spelling of the same setting.
    expect(parseHomeScopedSettingsKey(`${CAPACITY_LIMIT_KW}:${MAIN_HOME_ID}`)).toEqual({
      baseKey: `${CAPACITY_LIMIT_KW}:${MAIN_HOME_ID}`,
      homeId: MAIN_HOME_ID,
    });
  });

  it('leaves dot-namespaced per-device keys untouched', () => {
    expect(parseHomeScopedSettingsKey('deferred_objective.device-1')).toEqual({
      baseKey: 'deferred_objective.device-1',
      homeId: MAIN_HOME_ID,
    });
  });
});

describe('isHomeScopableBaseKey', () => {
  it('accepts exactly the home-scopable base keys', () => {
    for (const baseKey of [CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, CAPACITY_DRY_RUN, POWER_TRACKER_STATE]) {
      expect(isHomeScopableBaseKey(baseKey)).toBe(true);
    }
    expect(isHomeScopableBaseKey('daily_budget_kwh')).toBe(false);
    expect(isHomeScopableBaseKey(`${CAPACITY_LIMIT_KW}:cabin`)).toBe(false);
  });
});
