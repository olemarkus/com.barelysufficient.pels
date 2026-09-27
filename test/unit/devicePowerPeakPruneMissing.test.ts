/**
 * Coverage for `pruneMissingLearnedPeaks` — the per-plan-cycle sweep
 * that keeps the device-owned `lastKnownPowerKw` cache bounded by dropping
 * entries whose device IDs are no longer present in the latest snapshot.
 *
 * Without this sweep, removing a device from Homey at runtime leaks the
 * entry forever. Source: chunk-2 producer review of PR #1189.
 */
import { describe, expect, it } from 'vitest';
import { pruneMissingLearnedPeaks } from '../../lib/device/devicePowerPeak';
import type { LearnedPeaksByDeviceId } from '../../lib/device/devicePowerPeak';

describe('pruneMissingLearnedPeaks', () => {
  it('evicts nothing when the snapshot is empty', () => {
    // Homey SDK reads fail transiently, and an empty refresh is overwhelmingly
    // "the read failed" rather than "every device was deleted". Now that the
    // learned peak is persisted, one bad read would otherwise erase learning the
    // fleet took weeks to accumulate. A genuinely device-less home has nothing to
    // evict either way, so the guard costs nothing.
    //
    // This REPLACES an earlier assertion that an empty snapshot must drain the
    // cache "after a device wipe". Entries for genuinely removed devices are not
    // stranded: `saveLearnedPeaks` prunes anything whose window has closed, so a
    // real wipe self-heals within `PEAK_WINDOW_MS` instead of costing every
    // surviving device its learning on the first flaky read.
    const peaks: LearnedPeaksByDeviceId = {
      'present-1': { kw: 1.23, observedAtMs: 0 },
    };

    pruneMissingLearnedPeaks(peaks, new Set());

    expect(peaks['present-1']?.kw).toBe(1.23);
  });

  it('drops lastKnownPowerKw entries whose ids are not in the snapshot', () => {
    const peaks: LearnedPeaksByDeviceId = {
      'present-1': { kw: 1.23, observedAtMs: 0 },
      'orphan-1': { kw: 4.56, observedAtMs: 0 },
    };

    pruneMissingLearnedPeaks(peaks, new Set(['present-1']));

    expect(peaks['present-1']?.kw).toBe(1.23);
    expect(peaks['orphan-1']).toBeUndefined();
  });

  it('is a no-op when every cached id is present in the snapshot', () => {
    const peaks: LearnedPeaksByDeviceId = {
      a: { kw: 1, observedAtMs: 0 },
      b: { kw: 2, observedAtMs: 0 },
    };

    pruneMissingLearnedPeaks(peaks, new Set(['a', 'b']));

    expect(Object.keys(peaks).sort()).toEqual(['a', 'b']);
  });

});
