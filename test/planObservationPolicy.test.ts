import {
  STALE_DEVICE_OBSERVATION_MS,
  getLatestDeviceObservationMs,
  isDeviceObservationStale,
} from '../lib/plan/planObservationPolicy';

describe('plan observation policy', () => {
  it('does not treat a local write timestamp as a device observation', () => {
    const recentLocalWriteMs = Date.UTC(2026, 2, 26, 11, 59, 0);

    expect(getLatestDeviceObservationMs({
      lastLocalWriteMs: recentLocalWriteMs,
    })).toBeUndefined();
  });

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
