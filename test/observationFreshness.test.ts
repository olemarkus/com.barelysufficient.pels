import {
  STALE_DEVICE_OBSERVATION_MS,
  getDeviceObservationFreshness,
  getLatestDeviceObservationMs,
  isDeviceObservationStale,
  isDeviceObservationStaleByAge,
} from '../lib/observer/observationFreshness';

describe('observation freshness', () => {
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

  it('treats devices with no freshness timestamps as stale', () => {
    const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);

    expect(isDeviceObservationStale({}, nowMs)).toBe(true);
  });

  it('treats devices with only a local write and no observation as stale', () => {
    const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);

    expect(isDeviceObservationStale({
      lastLocalWriteMs: nowMs - 1_000,
    }, nowMs)).toBe(true);
  });

  describe('isDeviceObservationStaleByAge', () => {
    it('returns false for a device that has never produced a trusted observation', () => {
      const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);

      expect(isDeviceObservationStaleByAge({}, nowMs)).toBe(false);
      expect(isDeviceObservationStaleByAge({
        lastLocalWriteMs: nowMs - 1_000,
      }, nowMs)).toBe(false);
    });

    it('returns true when an observation exists but has aged past the threshold', () => {
      const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);

      expect(isDeviceObservationStaleByAge({
        lastFreshDataMs: nowMs - STALE_DEVICE_OBSERVATION_MS - 1_000,
      }, nowMs)).toBe(true);
    });

    it('returns false for a recent observation', () => {
      const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);

      expect(isDeviceObservationStaleByAge({
        lastFreshDataMs: nowMs - 1_000,
      }, nowMs)).toBe(false);
    });
  });

  describe('getDeviceObservationFreshness', () => {
    it('returns "unknown" for a device that has never produced a trusted observation', () => {
      const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);

      expect(getDeviceObservationFreshness({}, nowMs)).toBe('unknown');
      expect(getDeviceObservationFreshness({
        lastLocalWriteMs: nowMs - 1_000,
      }, nowMs)).toBe('unknown');
    });

    it('returns "stale" when an observation exists but has aged past the threshold', () => {
      const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);

      expect(getDeviceObservationFreshness({
        lastFreshDataMs: nowMs - STALE_DEVICE_OBSERVATION_MS - 1_000,
      }, nowMs)).toBe('stale');
    });

    it('returns "fresh" for a recent observation', () => {
      const nowMs = Date.UTC(2026, 2, 26, 12, 0, 0);

      expect(getDeviceObservationFreshness({
        lastFreshDataMs: nowMs - 1_000,
      }, nowMs)).toBe('fresh');
    });
  });
});
