import type Homey from 'homey';
import { MockSettings } from '../mocks/homey';
import { readWholeHomeMeterScopeSignature } from '../../setup/weatherMeterScopeSignature';
import {
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  HOMEY_ENERGY_METER_DEVICE_ID,
  POWER_SOURCE,
} from '../../lib/utils/settingsKeys';
import { LEGACY_MULTI_HOME_ENABLED } from '../../setup/multiHomeActivation';

// Integration seam: the meter-scope fingerprint composed over the REAL
// settings adapters (homes store, main-meter selection, power-source
// classification, activation posture) against the mock SDK settings store —
// composition rules (producer-specific arms, area-meter exclusion) and the
// unavailable classification of each branch's required reads. The end-to-end
// forget flow lives in test/integration/weatherMeterScopeInvalidation.test.ts.

const buildHomey = (): { settings: MockSettings } & Homey.App['homey'] => (
  { settings: new MockSettings() } as unknown as { settings: MockSettings } & Homey.App['homey']
);

const area = (homeId: string, meterDeviceId: string | null) => ({
  homeId, name: `Area ${homeId}`, rootZoneId: `zone-${homeId}`, meterDeviceId,
});

describe('readWholeHomeMeterScopeSignature', () => {
  it('makes the Flow fingerprint independent of every Homey Energy-only setting', () => {
    const homey = buildHomey();
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');
    homey.settings.set(HOMES_CONFIG, {
      activationVersion: 1,
      subHomes: [area('h_b', 'meter-b'), area('h_a', 'meter-a'), area('h_c', null)],
    });
    expect(readWholeHomeMeterScopeSignature(homey)).toBe('source:flow');

    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-other');
    homey.settings.set(HOMES_CONFIG, { subHomes: [area('h_a', 'meter-c')] });
    expect(readWholeHomeMeterScopeSignature(homey)).toBe('source:flow');
  });

  it('resolves Flow even when the irrelevant Main and homes settings are malformed', () => {
    const homey = buildHomey();
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 42);
    homey.settings.set(HOMES_CONFIG, { subHomes: 'corrupted' });
    expect(readWholeHomeMeterScopeSignature(homey)).toBe('source:flow');
  });

  it('composes Homey Energy with an explicit Main meter and no activation posture', () => {
    const homey = buildHomey();
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMES_CONFIG, { subHomes: [area('h_a', 'meter-a')] });
    expect(readWholeHomeMeterScopeSignature(homey)).toBe('source:homey_energy|main:meter-main');
  });

  it('keeps an explicit Main fingerprint across roster activation', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');
    homey.settings.set(HOMES_CONFIG, { subHomes: [area('h_a', 'meter-a')] });
    const before = readWholeHomeMeterScopeSignature(homey);
    homey.settings.set(HOMES_CONFIG, { activationVersion: 1, subHomes: [area('h_a', 'meter-a')] });
    expect(readWholeHomeMeterScopeSignature(homey)).toBe(before);
  });

  it('resolves a persisted empty config to the Automatic Main scope', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    homey.settings.set(HOMES_CONFIG, { activationVersion: 1, subHomes: [] });
    expect(readWholeHomeMeterScopeSignature(homey))
      .toBe('source:homey_energy|main:automatic|areas:active');
  });

  it('resolves an unwritten registry to the normal single-home Automatic Main scope', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);

    expect(readWholeHomeMeterScopeSignature(homey))
      .toBe('source:homey_energy|main:automatic|areas:active');
  });

  it('excludes area meter ids — an area re-meter never changes the series behind Main\'s history', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    homey.settings.set(HOMES_CONFIG, { activationVersion: 1, subHomes: [area('h_a', 'meter-a')] });
    const before = readWholeHomeMeterScopeSignature(homey);
    homey.settings.set(HOMES_CONFIG, { activationVersion: 1, subHomes: [area('h_a', 'meter-b')] });
    expect(readWholeHomeMeterScopeSignature(homey)).toBe(before);
  });

  it('composes the dormant posture for a never-activated, legacy-off roster', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    homey.settings.set(HOMES_CONFIG, { subHomes: [area('h_a', 'meter-a')] });
    expect(readWholeHomeMeterScopeSignature(homey))
      .toBe('source:homey_energy|main:automatic|areas:dormant');
  });

  it('composes the active posture once the legacy flag provides activation evidence', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    homey.settings.set(LEGACY_MULTI_HOME_ENABLED, true);
    homey.settings.set(HOMES_CONFIG, { subHomes: [area('h_a', 'meter-a')] });
    expect(readWholeHomeMeterScopeSignature(homey))
      .toBe('source:homey_energy|main:automatic|areas:active');
  });

  it('returns undefined when the legacy activation flag is unreadable and decisive', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    // Populated, no activation marker: only the legacy flag can decide the
    // posture — a failed read must compose to unavailable, never to a
    // definite dormant arm (which would fire a destructive forget).
    homey.settings.set(HOMES_CONFIG, { subHomes: [area('h_a', 'meter-a')] });
    const original = homey.settings.get.bind(homey.settings);
    vi.spyOn(homey.settings, 'get').mockImplementation((key: string) => {
      if (key === LEGACY_MULTI_HOME_ENABLED) throw new Error('settings backend hiccup');
      return original(key);
    });
    expect(readWholeHomeMeterScopeSignature(homey)).toBeUndefined();
  });

  it('composes despite an unreadable legacy flag when the activation marker already decides', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    homey.settings.set(HOMES_CONFIG, { activationVersion: 1, subHomes: [area('h_a', 'meter-a')] });
    const original = homey.settings.get.bind(homey.settings);
    vi.spyOn(homey.settings, 'get').mockImplementation((key: string) => {
      if (key === LEGACY_MULTI_HOME_ENABLED) throw new Error('settings backend hiccup');
      return original(key);
    });
    expect(readWholeHomeMeterScopeSignature(homey))
      .toBe('source:homey_energy|main:automatic|areas:active');
  });

  it('returns undefined on a suspect homes blob — a failed read is not evidence of change', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    // Junk blob (sub-home id 'main' is implausible) → the store classifies 'suspect'.
    homey.settings.set(HOMES_CONFIG, { subHomes: [area('main', 'meter-a')] });
    expect(readWholeHomeMeterScopeSignature(homey)).toBeUndefined();
  });

  it('preserves uncertainty when a failed marker backfill lets a later miss read as unwritten', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, null);
    homey.settings.set(HOMES_CONFIG, { subHomes: [area('h_a', 'meter-a')] });
    const originalSet = homey.settings.set.bind(homey.settings);
    vi.spyOn(homey.settings, 'set').mockImplementation((key: string, value: unknown) => {
      if (key === HOMES_CONFIG_INITIALIZED) throw new Error('marker write failed');
      originalSet(key, value);
    });

    expect(readWholeHomeMeterScopeSignature(homey))
      .toBe('source:homey_energy|main:automatic|areas:dormant');
    originalSet(HOMES_CONFIG, undefined);
    expect(readWholeHomeMeterScopeSignature(homey)).toBeUndefined();
  });

  it('does not require a homes read for Homey Energy with an explicit Main meter', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');
    homey.settings.set(HOMES_CONFIG, { subHomes: 'corrupted' });
    expect(readWholeHomeMeterScopeSignature(homey)).toBe('source:homey_energy|main:meter-main');
  });

  it('returns undefined when the Main meter selection is unclassifiable', () => {
    const homey = buildHomey();
    homey.settings.set(POWER_SOURCE, 'homey_energy');
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 42);
    expect(readWholeHomeMeterScopeSignature(homey)).toBeUndefined();
  });

  it.each(['automatic', 'meter-main|areas:active', 'meter main'])(
    'does not compose a noncanonical explicit Main meter id: %s',
    (meterDeviceId) => {
      const homey = buildHomey();
      homey.settings.set(POWER_SOURCE, 'homey_energy');
      homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, meterDeviceId);
      expect(readWholeHomeMeterScopeSignature(homey)).toBeUndefined();
    },
  );

  it('returns undefined on a suspect power-source read — the meter arms alone must not compose', () => {
    const homey = buildHomey();
    homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'meter-main');
    // Key present but value unreadable → `missing_existing_key` suspect: the
    // classifier must not convert a transient miss into the Flow default.
    homey.settings.set(POWER_SOURCE, undefined);
    expect(readWholeHomeMeterScopeSignature(homey)).toBeUndefined();
  });
});
