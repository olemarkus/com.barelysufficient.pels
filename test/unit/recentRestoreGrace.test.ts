import { resolveRecentRestoreState } from '../../lib/plan/shedding/overshoot';
import { resolveRecentRestoreGraceMs, RECENT_RESTORE_SHED_GRACE_MS } from '../../lib/plan/planConstants';
import { createPlanEngineState } from '../../lib/plan/planState';

const NOW = 1_000_000_000;
const MINUTE_MS = 60_000;

const buildDevice = (minRunMinutes?: number) => ({
  id: 'dev-1',
  name: 'Device 1',
  ...(minRunMinutes === undefined ? {} : { minRunMinutes }),
});

const stateWithRestoreAt = (restoredMs: number) => {
  const state = createPlanEngineState(NOW);
  state.lastDeviceRestoreMs = { 'dev-1': restoredMs };
  return state;
};

describe('resolveRecentRestoreGraceMs', () => {
  it('falls back to the legacy 3-minute grace when min-run is unset', () => {
    expect(resolveRecentRestoreGraceMs(undefined)).toBe(RECENT_RESTORE_SHED_GRACE_MS);
    expect(RECENT_RESTORE_SHED_GRACE_MS).toBe(3 * MINUTE_MS);
  });

  it('falls back to the legacy grace for a 0 (opt-out) value', () => {
    expect(resolveRecentRestoreGraceMs(0)).toBe(RECENT_RESTORE_SHED_GRACE_MS);
  });

  it('scales the grace by the per-device minutes when positive', () => {
    expect(resolveRecentRestoreGraceMs(20)).toBe(20 * MINUTE_MS);
  });

  it('rejects negative values and falls back to the legacy grace', () => {
    expect(resolveRecentRestoreGraceMs(-5)).toBe(RECENT_RESTORE_SHED_GRACE_MS);
  });
});

describe('resolveRecentRestoreState', () => {
  it('uses exactly the 3-minute legacy grace when min-run is unset (behaviour parity)', () => {
    // Restored 2m59s ago -> still within the legacy grace.
    expect(resolveRecentRestoreState({
      device: buildDevice(),
      state: stateWithRestoreAt(NOW - (3 * MINUTE_MS - 1_000)),
      nowTs: NOW,
      needed: 0.1,
    })).toBe(true);

    // Restored 3m01s ago -> past the legacy grace.
    expect(resolveRecentRestoreState({
      device: buildDevice(),
      state: stateWithRestoreAt(NOW - (3 * MINUTE_MS + 1_000)),
      nowTs: NOW,
      needed: 0.1,
    })).toBe(false);
  });

  it('honours a per-device min-run of 20 minutes', () => {
    // Restored 10 minutes ago -> still recently restored under a 20m hold.
    expect(resolveRecentRestoreState({
      device: buildDevice(20),
      state: stateWithRestoreAt(NOW - 10 * MINUTE_MS),
      nowTs: NOW,
      needed: 0.1,
    })).toBe(true);

    // Restored 25 minutes ago -> past the 20m hold.
    expect(resolveRecentRestoreState({
      device: buildDevice(20),
      state: stateWithRestoreAt(NOW - 25 * MINUTE_MS),
      nowTs: NOW,
      needed: 0.1,
    })).toBe(false);
  });

  it('lets a hard overshoot (>= 0.5 kW) bypass the hold regardless of min-run', () => {
    expect(resolveRecentRestoreState({
      device: buildDevice(20),
      state: stateWithRestoreAt(NOW - MINUTE_MS),
      nowTs: NOW,
      // Above RECENT_RESTORE_OVERSHOOT_BYPASS_KW (0.5).
      needed: 0.6,
    })).toBe(false);
  });

  it('returns false when the device was never restored', () => {
    expect(resolveRecentRestoreState({
      device: buildDevice(20),
      state: createPlanEngineState(NOW),
      nowTs: NOW,
      needed: 0.1,
    })).toBe(false);
  });
});
