// Integration tests for the capacity scalar settings boundary
// (`setup/capacitySettingsStoreAdapter.ts`), one layer over the shared
// MockSettings seam: home-scoped key mapping (main = historical unsuffixed
// keys, other homes = `<key>:<homeId>`) and the exact historical fallback
// semantics — a non-finite scalar or non-boolean dry-run flag resolves to the
// construction-bound last-good provider's value, never a fabricated default.
import { describe, expect, it } from 'vitest';
import { createCapacitySettingsStore } from '../../setup/capacitySettingsStoreAdapter';
import type { CapacityScalarSettings } from '../../lib/power/capacitySettingsStore';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  MAIN_HOME_ID,
} from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';

const fallback = (): CapacityScalarSettings => ({ limitKw: 12, marginKw: 0.5, dryRun: false });

describe('createCapacitySettingsStore', () => {
  it('reads the historical unsuffixed keys for the main home', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 7.5);
    settings.set(CAPACITY_MARGIN_KW, 0.4);
    settings.set(CAPACITY_DRY_RUN, true);
    // Suffixed decoys must be invisible to the main home.
    settings.set(`${CAPACITY_LIMIT_KW}:${MAIN_HOME_ID}`, 99);
    settings.set(`${CAPACITY_LIMIT_KW}:cabin`, 3);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ limitKw: 7.5, marginKw: 0.4, dryRun: true });
  });

  it('reads home-suffixed keys for a non-main home', () => {
    const settings = new MockSettings();
    // Unsuffixed (main-home) values must be invisible to another home.
    settings.set(CAPACITY_LIMIT_KW, 10);
    settings.set(CAPACITY_MARGIN_KW, 0.2);
    settings.set(CAPACITY_DRY_RUN, true);
    settings.set(`${CAPACITY_LIMIT_KW}:cabin`, 5);
    settings.set(`${CAPACITY_MARGIN_KW}:cabin`, 0.1);
    settings.set(`${CAPACITY_DRY_RUN}:cabin`, false);

    const store = createCapacitySettingsStore(settings, 'cabin', fallback);

    expect(store.read()).toEqual({ limitKw: 5, marginKw: 0.1, dryRun: false });
  });

  it('does not bleed main-home values into a home whose keys are unset', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 10);
    settings.set(CAPACITY_MARGIN_KW, 0.2);
    settings.set(CAPACITY_DRY_RUN, true);

    const store = createCapacitySettingsStore(settings, 'cabin', fallback);

    expect(store.read()).toEqual(fallback());
  });

  it.each([
    ['a numeric string', '12'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['null', null],
    ['an object blob', { limitKw: 9 }],
  ])('falls back to the caller-supplied scalar when the persisted value is %s', (_label, junk) => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, junk);
    settings.set(CAPACITY_MARGIN_KW, junk);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ limitKw: 12, marginKw: 0.5, dryRun: false });
  });

  it.each([
    ['a boolean string', 'true'],
    ['a truthy number', 1],
    ['null', null],
    ['undefined', undefined],
  ])('falls back to the caller-supplied dry-run flag when the persisted value is %s', (_label, junk) => {
    const settings = new MockSettings();
    settings.set(CAPACITY_DRY_RUN, junk);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, () => ({ ...fallback(), dryRun: true }));

    expect(store.read().dryRun).toBe(true);
  });

  it('respects an explicit dry-run false over a true fallback', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_DRY_RUN, false);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, () => ({ ...fallback(), dryRun: true }));

    expect(store.read().dryRun).toBe(false);
  });

  it('passes any finite scalar through unbounded, exactly like the historical reads', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 0);
    settings.set(CAPACITY_MARGIN_KW, -0.3);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ limitKw: 0, marginKw: -0.3, dryRun: false });
  });

  it('resolves each field independently when only some persisted values are junk', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 8);
    settings.set(CAPACITY_MARGIN_KW, 'oops');
    settings.set(CAPACITY_DRY_RUN, 'yes');

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ limitKw: 8, marginKw: 0.5, dryRun: false });
  });
});
