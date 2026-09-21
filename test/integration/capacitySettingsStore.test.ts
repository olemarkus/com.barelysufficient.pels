// Integration tests for the capacity scalar settings boundary
// (`lib/power/capacitySettingsStore.ts`), one layer over the shared
// MockSettings seam: home-scoped key mapping (main = historical unsuffixed
// keys, other homes = `<key>:<homeId>`) and the exact fallback semantics — a
// non-finite scalar or non-boolean dry-run flag resolves to the construction-
// bound last-good provider, while an unreadable listed period is unavailable.
import { describe, expect, it } from 'vitest';
import { createCapacitySettingsStore } from '../../lib/power/capacitySettingsStore';
import type { CapacityScalarSettingsRead } from '../../lib/power/capacitySettingsStore';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  MAIN_HOME_ID,
} from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';

const fallback = (): CapacityScalarSettings => ({ limitKw: 12, marginKw: 0.5, dryRun: false, periodMinutes: 60 });
const resolvedValue = (read: CapacityScalarSettingsRead): CapacityScalarSettings => {
  expect(read.state).toBe('resolved');
  if (read.state === 'unavailable') throw new Error('expected resolved capacity settings');
  return read.value;
};

describe('createCapacitySettingsStore', () => {
  it('treats an empty SDK key list as unavailable', () => {
    const store = createCapacitySettingsStore(new MockSettings(), MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ state: 'unavailable' });
  });

  it('reads the historical unsuffixed keys for the main home', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 7.5);
    settings.set(CAPACITY_MARGIN_KW, 0.4);
    settings.set(CAPACITY_DRY_RUN, true);
    // Suffixed decoys must be invisible to the main home.
    settings.set(`${CAPACITY_LIMIT_KW}:${MAIN_HOME_ID}`, 99);
    settings.set(`${CAPACITY_LIMIT_KW}:cabin`, 3);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.readHardCapConfiguration()).toEqual({ state: 'resolved', configured: true });
    expect(resolvedValue(store.read())).toEqual({ limitKw: 7.5, marginKw: 0.4, dryRun: true, periodMinutes: 60 });
  });

  it('resolves an unwritten hard cap from key presence without mistaking the fallback for a saved value', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_MARGIN_KW, 0.4);
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.readHardCapConfiguration()).toEqual({ state: 'resolved', configured: false });
    expect(resolvedValue(store.read()).limitKw).toBe(12);
  });

  it('keeps unavailable hard-cap provenance explicit at the UI boundary', () => {
    const store = createCapacitySettingsStore(new MockSettings(), MAIN_HOME_ID, fallback);
    expect(store.readHardCapConfiguration()).toEqual({ state: 'unavailable' });
  });

  it('keeps a listed hard cap configured when its value read is transiently unavailable', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 7.5);
    const readSetting = settings.get.bind(settings);
    settings.get = (key: string): unknown => (key === CAPACITY_LIMIT_KW ? null : readSetting(key));
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({
      state: 'resolved',
      value: fallback(),
    });
    expect(store.readHardCapConfiguration()).toEqual({ state: 'resolved', configured: true });
  });

  it('keeps hard-cap provenance resolved when an unrelated listed period is malformed', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 8);
    settings.set(CAPACITY_PERIOD_MINUTES, 30);
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ state: 'unavailable' });
    expect(store.readHardCapConfiguration()).toEqual({ state: 'resolved', configured: true });
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

    expect(resolvedValue(store.read())).toEqual({ limitKw: 5, marginKw: 0.1, dryRun: false, periodMinutes: 60 });
  });

  it('does not bleed main-home values into a home whose keys are unset', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 10);
    settings.set(CAPACITY_MARGIN_KW, 0.2);
    settings.set(CAPACITY_DRY_RUN, true);

    const store = createCapacitySettingsStore(settings, 'cabin', fallback);

    expect(resolvedValue(store.read())).toEqual(fallback());
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

    expect(resolvedValue(store.read())).toEqual({ limitKw: 12, marginKw: 0.5, dryRun: false, periodMinutes: 60 });
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

    expect(resolvedValue(store.read()).dryRun).toBe(true);
  });

  it('respects an explicit dry-run false over a true fallback', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_DRY_RUN, false);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, () => ({ ...fallback(), dryRun: true }));

    expect(resolvedValue(store.read()).dryRun).toBe(false);
  });

  it('reads the Belgian quarter-hour period and rejects an unreadable listed value', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_PERIOD_MINUTES, 15);
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, () => ({ ...fallback(), periodMinutes: 15 }));

    expect(resolvedValue(store.read()).periodMinutes).toBe(15);

    settings.set(CAPACITY_PERIOD_MINUTES, 30);
    expect(store.read()).toEqual({ state: 'unavailable' });
  });

  it('distinguishes a transient listed-key miss from an unwritten period', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 8);
    settings.set(CAPACITY_PERIOD_MINUTES, 15);
    const readSetting = settings.get.bind(settings);
    let missPeriod = true;
    settings.get = (key: string): unknown => (
      key === CAPACITY_PERIOD_MINUTES && missPeriod ? null : readSetting(key)
    );
    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(store.read()).toEqual({ state: 'unavailable' });
    missPeriod = false;
    expect(resolvedValue(store.read()).periodMinutes).toBe(15);

    settings.unset(CAPACITY_PERIOD_MINUTES);
    expect(resolvedValue(store.read()).periodMinutes).toBe(60);
  });

  it('passes any finite scalar through unbounded, exactly like the historical reads', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 0);
    settings.set(CAPACITY_MARGIN_KW, -0.3);

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(resolvedValue(store.read())).toEqual({ limitKw: 0, marginKw: -0.3, dryRun: false, periodMinutes: 60 });
  });

  it('resolves each field independently when only some persisted values are junk', () => {
    const settings = new MockSettings();
    settings.set(CAPACITY_LIMIT_KW, 8);
    settings.set(CAPACITY_MARGIN_KW, 'oops');
    settings.set(CAPACITY_DRY_RUN, 'yes');

    const store = createCapacitySettingsStore(settings, MAIN_HOME_ID, fallback);

    expect(resolvedValue(store.read())).toEqual({ limitKw: 8, marginKw: 0.5, dryRun: false, periodMinutes: 60 });
  });
});
