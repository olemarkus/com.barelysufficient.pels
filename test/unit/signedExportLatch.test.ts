// The export half of solar-surplus reachability, as a persisted one-way latch.
//
// The tracker's export families are accounting history: "Reset usage history"
// empties them and retention prunes them. Reading reachability straight off
// them let a reset drop an opted-in dump load's surplus posture, after which the
// generic restore lane ran it from the grid.
import { describe, expect, it } from 'vitest';
import { SignedExportLatch } from '../../lib/power/signedExportLatch';
import { SIGNED_EXPORT_OBSERVED } from '../../lib/utils/settingsKeys';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';

type FakeSettings = SettingsPort & {
  values: Map<string, unknown>;
  failWrites: boolean;
  failReads: boolean;
  keysOverride: string[] | null;
  reads: number;
};

const fakeSettings = (initial: Record<string, unknown> = {}): FakeSettings => {
  const values = new Map<string, unknown>(Object.entries(initial));
  const settings: FakeSettings = {
    values,
    failWrites: false,
    failReads: false,
    keysOverride: null,
    reads: 0,
    get: (key) => {
      settings.reads += 1;
      if (settings.failReads) throw new Error('settings read failed');
      return values.get(key);
    },
    set: (key, value) => {
      if (settings.failWrites) throw new Error('settings write failed');
      values.set(key, value);
    },
    unset: (key) => { values.delete(key); },
    getKeys: () => settings.keysOverride ?? [...values.keys()],
  };
  return settings;
};

const withExport = (kWh: number): PowerTrackerState => ({ exportDailyTotals: { '2026-08-05': kWh } });
const EMPTY: PowerTrackerState = {};
// Another key keeps the list non-empty, so "not listed" is a real answer.
const OTHER = { power_source: 'flow' };

describe('SignedExportLatch', () => {
  it('answers false and writes nothing for a feed that has never exported', () => {
    const settings = fakeSettings(OTHER);
    const latch = new SignedExportLatch(settings);
    latch.observe(EMPTY);
    expect(latch.readEvidence()).toBe('none');
    expect(settings.values.has(SIGNED_EXPORT_OBSERVED)).toBe(false);
  });

  it('arms and persists on ANY recorded export, well below the export-price materiality floor', () => {
    // The bar is "can the feed express export at all", which one negative
    // sample settles; the 1 kWh floor would blank the posture for the first
    // ~20 minutes of a home's first sunny afternoon.
    const settings = fakeSettings(OTHER);
    const latch = new SignedExportLatch(settings);
    latch.observe(withExport(0.02));
    expect(latch.readEvidence()).toBe('expressed');
    expect(settings.values.get(SIGNED_EXPORT_OBSERVED)).toBe(true);
  });

  it('stays armed after the usage history is reset', () => {
    // The defect: the reset emptied the export families, the pool read
    // unreachable, and the dump load lost its surplus posture.
    const latch = new SignedExportLatch(fakeSettings(OTHER));
    latch.observe(withExport(4));
    latch.observe(EMPTY);
    expect(latch.readEvidence()).toBe('expressed');
  });

  it('answers from the stored bit after a restart, with the history gone', () => {
    const latch = new SignedExportLatch(fakeSettings({ ...OTHER, [SIGNED_EXPORT_OBSERVED]: true }));
    expect(latch.readEvidence()).toBe('expressed');
  });

  it('asks the store again after a read the key list contradicts', () => {
    // A listed key that reads back empty is a transient SDK miss, not "never
    // observed": the next question must read it again.
    const settings = fakeSettings({ ...OTHER, [SIGNED_EXPORT_OBSERVED]: undefined });
    const latch = new SignedExportLatch(settings);
    expect(latch.readEvidence()).toBe('unreadable');
    settings.values.set(SIGNED_EXPORT_OBSERVED, true);
    expect(latch.readEvidence()).toBe('expressed');
  });

  it('settles nothing on an empty key list — a flake, not an empty store', () => {
    const settings = fakeSettings({ [SIGNED_EXPORT_OBSERVED]: true });
    settings.values.delete(SIGNED_EXPORT_OBSERVED);
    settings.keysOverride = [];
    const latch = new SignedExportLatch(settings);
    expect(latch.readEvidence()).toBe('unreadable');
    settings.values.set(SIGNED_EXPORT_OBSERVED, true);
    settings.keysOverride = null;
    expect(latch.readEvidence()).toBe('expressed');
  });

  it('contains a thrown read and asks again next time', () => {
    const settings = fakeSettings({ ...OTHER, [SIGNED_EXPORT_OBSERVED]: true });
    settings.failReads = true;
    const latch = new SignedExportLatch(settings);
    expect(latch.readEvidence()).toBe('unreadable');
    settings.failReads = false;
    expect(latch.readEvidence()).toBe('expressed');
  });

  it('settles a foreign stored value as unarmed instead of re-reading it on every question', () => {
    const settings = fakeSettings({ ...OTHER, [SIGNED_EXPORT_OBSERVED]: 'yes' });
    const latch = new SignedExportLatch(settings);
    expect(latch.readEvidence()).toBe('none');
    const readsAfterFirst = settings.reads;
    expect(latch.readEvidence()).toBe('none');
    expect(settings.reads).toBe(readsAfterFirst);
    // Arming writes the real bit over it.
    latch.observe(withExport(1));
    expect(settings.values.get(SIGNED_EXPORT_OBSERVED)).toBe(true);
  });

  it('retries a failed write on the next observation while answering true', () => {
    const settings = fakeSettings(OTHER);
    settings.failWrites = true;
    const latch = new SignedExportLatch(settings);
    latch.observe(withExport(1));
    expect(latch.readEvidence()).toBe('expressed');
    expect(settings.values.has(SIGNED_EXPORT_OBSERVED)).toBe(false);
    settings.failWrites = false;
    latch.observe(EMPTY);
    expect(settings.values.get(SIGNED_EXPORT_OBSERVED)).toBe(true);
  });
});
