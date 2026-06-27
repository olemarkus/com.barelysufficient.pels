import { describe, it, expect } from 'vitest';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import {
  TARGETED_DEVICE_MISS_GRACE_MS,
  TARGETED_DEVICE_MISS_GRACE_READS,
  type TargetedMissState,
  mergeTargetedRefreshSnapshot,
  overlayRetainedTrackedDevices,
} from '../../lib/device/transport/targetedSnapshotMerge';

// Minimal snapshot — the pure merge only reads `.id`.
const snap = (id: string): TransportDeviceSnapshot => ({ id } as unknown as TransportDeviceSnapshot);
const ids = (list: { id: string }[]) => list.map((d) => d.id).sort();
const raw = (id: string): HomeyDeviceLike => ({ id } as unknown as HomeyDeviceLike);

describe('mergeTargetedRefreshSnapshot', () => {
  const prev = [snap('a'), snap('b'), snap('c')];

  it('updates present devices and retains a NETWORK-missed device within grace', () => {
    const missByDeviceId = new Map<string, TargetedMissState>();
    const { snapshot, graceExceededIds } = mergeTargetedRefreshSnapshot({
      presentSnapshot: [snap('a'), snap('c')], // b absent
      previousSnapshot: prev,
      failedIds: ['b'], // b's by-id read failed (network)
      missByDeviceId,
      nowMs: 1000,
    });
    expect(ids(snapshot)).toEqual(['a', 'b', 'c']);
    expect(graceExceededIds).toEqual([]);
    // b's miss state is tracked, first-seen stamped.
    expect(missByDeviceId.get('b')).toEqual({ misses: 1, firstMissMs: 1000 });
  });

  it('drops a fetched-but-parsed-out device IMMEDIATELY (not in failedIds, no grace)', () => {
    const missByDeviceId = new Map<string, TargetedMissState>();
    const { snapshot, graceExceededIds } = mergeTargetedRefreshSnapshot({
      presentSnapshot: [snap('a'), snap('c')], // b absent because PARSE dropped it
      previousSnapshot: prev,
      failedIds: [], // b's read SUCCEEDED — it was parsed out, not a network miss
      missByDeviceId,
      nowMs: 1000,
    });
    // b is dropped immediately — never retained, projection pruned to match.
    expect(ids(snapshot)).toEqual(['a', 'c']);
    expect(graceExceededIds).toEqual([]);
    expect(missByDeviceId.has('b')).toBe(false);
  });

  it('clears a prior miss entry when the device becomes parsed-out (no grace carry-over)', () => {
    const missByDeviceId = new Map<string, TargetedMissState>([['b', { misses: 2, firstMissMs: 0 }]]);
    const { snapshot } = mergeTargetedRefreshSnapshot({
      presentSnapshot: [snap('a'), snap('c')], // b absent, now parsed out (succeeded)
      previousSnapshot: prev,
      failedIds: [], // not a network miss
      missByDeviceId,
      nowMs: 5_000,
    });
    expect(ids(snapshot)).toEqual(['a', 'c']);
    expect(missByDeviceId.has('b')).toBe(false);
  });

  it('a successful read resets the miss state', () => {
    const missByDeviceId = new Map<string, TargetedMissState>([['b', { misses: 2, firstMissMs: 0 }]]);
    mergeTargetedRefreshSnapshot({
      presentSnapshot: [snap('a'), snap('b'), snap('c')],
      previousSnapshot: prev,
      failedIds: [],
      missByDeviceId,
      nowMs: 5_000,
    });
    expect(missByDeviceId.has('b')).toBe(false);
  });

  it('drops + reports a device only after BOTH the read count AND the wall-clock floor', () => {
    const missByDeviceId = new Map<string, TargetedMissState>();
    const present = [snap('a'), snap('c')]; // b always missed (network)
    const failedIds = ['b'];

    // Read count reaches the threshold quickly, but within the wall-clock floor:
    // retained (count met, clock not).
    let nowMs = 0;
    for (let i = 0; i < TARGETED_DEVICE_MISS_GRACE_READS + 2; i += 1) {
      const r = mergeTargetedRefreshSnapshot({ presentSnapshot: present, previousSnapshot: prev, failedIds, missByDeviceId, nowMs });
      expect(ids(r.snapshot)).toContain('b');
      expect(r.graceExceededIds).toEqual([]);
      nowMs += 1_000; // 1s apart — never crosses the floor
    }
    expect(missByDeviceId.has('b')).toBe(true);

    // Now a miss past the wall-clock floor with the count already met → dropped.
    nowMs = TARGETED_DEVICE_MISS_GRACE_MS + 10_000;
    const dropped = mergeTargetedRefreshSnapshot({ presentSnapshot: present, previousSnapshot: prev, failedIds, missByDeviceId, nowMs });
    expect(ids(dropped.snapshot)).toEqual(['a', 'c']);
    expect(dropped.graceExceededIds).toEqual(['b']);
    expect(missByDeviceId.has('b')).toBe(false);
  });

  it('the wall-clock floor alone does not drop without the read count', () => {
    // Seed an in-progress miss (count 1 < READS) whose first-seen is far in the
    // past, then miss again past the wall-clock floor: the time floor is met but
    // the count floor is not, so the device is RETAINED (proves count is required).
    const missByDeviceId = new Map<string, TargetedMissState>([['b', { misses: 1, firstMissMs: 0 }]]);
    const r = mergeTargetedRefreshSnapshot({
      presentSnapshot: [snap('a'), snap('c')],
      previousSnapshot: prev,
      failedIds: ['b'],
      missByDeviceId,
      nowMs: TARGETED_DEVICE_MISS_GRACE_MS + 1,
    });
    expect(ids(r.snapshot)).toContain('b');
    expect(r.graceExceededIds).toEqual([]);
    // count advanced to 2 but still < READS (3) → not dropped.
    expect(missByDeviceId.get('b')?.misses).toBeLessThan(TARGETED_DEVICE_MISS_GRACE_READS);
  });

  it('prunes the miss counter for ids no longer requested', () => {
    const missByDeviceId = new Map<string, TargetedMissState>([['gone', { misses: 1, firstMissMs: 0 }]]);
    mergeTargetedRefreshSnapshot({
      presentSnapshot: [snap('a')],
      previousSnapshot: [snap('a'), snap('b')], // 'gone' not requested
      failedIds: [],
      missByDeviceId,
      nowMs: 1_000,
    });
    expect(missByDeviceId.has('gone')).toBe(false);
  });
});

describe('overlayRetainedTrackedDevices', () => {
  it('keeps the prior raw entry for a committed-but-absent (retained) device', () => {
    const priorRawById = new Map<string, HomeyDeviceLike>([['b', raw('b')]]);
    const trackingList = overlayRetainedTrackedDevices({
      effectiveList: [raw('a')], // only a read this cycle
      committedSnapshot: [snap('a'), snap('b')], // b retained in the committed snapshot
      priorRawById,
    });
    expect(trackingList.map((d) => (d as { id: string }).id).sort()).toEqual(['a', 'b']);
  });

  it('omits a retained device with no prior raw entry (cannot track what was never tracked)', () => {
    const trackingList = overlayRetainedTrackedDevices({
      effectiveList: [raw('a')],
      committedSnapshot: [snap('a'), snap('b')],
      priorRawById: new Map(),
    });
    expect(trackingList.map((d) => (d as { id: string }).id)).toEqual(['a']);
  });
});
