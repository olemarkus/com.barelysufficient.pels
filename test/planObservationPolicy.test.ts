import {
  STALE_DEVICE_OBSERVATION_MS,
  isDeviceObservationStale,
} from '../lib/plan/planObservationPolicy';

describe('plan observation policy', () => {
  it('does not let a recent local write hide an old live observation', () => {
    const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);
    const oldFreshDataMs = nowMs - STALE_DEVICE_OBSERVATION_MS - 1_000;
    const recentLocalWriteMs = nowMs - 1_000;

    expect(isDeviceObservationStale({
      lastFreshDataMs: oldFreshDataMs,
      lastLocalWriteMs: recentLocalWriteMs,
    }, nowMs)).toBe(true);
  });

  it('currently treats devices with no freshness timestamps as not stale', () => {
    const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);

    expect(isDeviceObservationStale({}, nowMs)).toBe(false);
  });
});
