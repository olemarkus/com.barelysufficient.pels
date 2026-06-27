import type { HomeyDeviceLike } from '../../utils/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import { getDeviceId } from './managerHelpers';

/**
 * Targeted-refresh merge-overlay + per-device miss grace — pure functions, no
 * transport state of their own. `DeviceTransport` owns the miss-counter map and
 * passes it in; this module decides retain-vs-drop and builds the committed
 * device lists.
 *
 * A targeted (by-id) refresh is UPDATE-ONLY: it re-reads only the already-known
 * device ids, so a device that failed its single by-id read this cycle
 * (404/timeout/invalid payload) is a TRANSIENT MISS, not a removal. It is
 * retained in the committed snapshot (with its prior entry) so it stays planned,
 * keeps its per-device plan state, stays in the targeted id set (retried next
 * cycle), and ages via the existing staleness backstop. A per-device grace —
 * the sibling of the whole-snapshot empty-read abandon-grace, gated on BOTH a
 * consecutive-miss count AND a wall-clock floor — drops a device only after it
 * has been missing long enough to be a genuine removal.
 *
 * The wall-clock floor matters under `power_source = flow`, where refreshes
 * arrive at irregular cadence: a count-only grace could evict a present-but-flaky
 * device in seconds during a burst. Both conditions must hold to drop.
 */

// Canonical whole-snapshot/abandon-grace numerics, shared with the transport's
// empty-snapshot grace (`shouldDeferEmptySnapshotCommit`) so the two stay
// coupled to one source of truth.
export const SNAPSHOT_ABANDON_GRACE_MS = 5 * 60 * 1000;
export const SNAPSHOT_ABANDON_GRACE_READS = 3;

// Per-device targeted-miss grace: drop a missed device only once it has been
// missing for this many CONSECUTIVE targeted reads AND this long in wall-clock
// time. Aliased to the whole-snapshot grace so they evolve together.
export const TARGETED_DEVICE_MISS_GRACE_READS = SNAPSHOT_ABANDON_GRACE_READS;
export const TARGETED_DEVICE_MISS_GRACE_MS = SNAPSHOT_ABANDON_GRACE_MS;

/** Per-device transient-miss tracking for targeted refreshes. */
export type TargetedMissState = { misses: number; firstMissMs: number };

export type TargetedRefreshMergeResult = {
    /** The committed snapshot: present (updated) + within-grace retained. */
    snapshot: TransportDeviceSnapshot[];
    /** Devices dropped this cycle because the grace was exceeded. */
    graceExceededIds: string[];
};

/**
 * Overlay the freshly-read present devices onto the prior snapshot, applying the
 * per-device miss grace. Mutates `missByDeviceId` (the transport's counter map):
 * a successful read resets a device's entry, a within-grace NETWORK miss
 * increments it, a grace-exceeded miss clears it and reports the id for dropping.
 *
 * `failedIds` is the set of ids whose by-id NETWORK read actually failed this
 * cycle — the ONLY ids the grace may retain. A previous-snapshot device absent
 * from `presentSnapshot` but NOT in `failedIds` was fetched successfully and
 * dropped by PARSING (unmanaged/unsupported/ineligible/invalid); it is an
 * intentional removal and is DROPPED immediately (no grace), mirroring the
 * whole-snapshot "raw-nonempty-but-parsed-empty commits immediately" invariant.
 */
export function mergeTargetedRefreshSnapshot(params: {
    presentSnapshot: TransportDeviceSnapshot[];
    previousSnapshot: readonly TransportDeviceSnapshot[];
    failedIds: readonly string[];
    missByDeviceId: Map<string, TargetedMissState>;
    nowMs: number;
}): TargetedRefreshMergeResult {
    const { presentSnapshot, previousSnapshot, failedIds, missByDeviceId, nowMs } = params;
    const presentById = new Map(presentSnapshot.map((device) => [device.id, device]));
    const networkFailedIds = new Set(failedIds);
    // The targeted request covered exactly the prior known ids
    // (`fetchDevicesByKnownIds` derives them from `latestSnapshot`). Reset the
    // counter for any id no longer requested so the map can't leak. Collect stale
    // keys first (no spread allocation), then delete.
    const requestedIds = new Set(previousSnapshot.map((device) => device.id));
    const staleMissIds: string[] = [];
    for (const deviceId of missByDeviceId.keys()) {
        if (!requestedIds.has(deviceId)) staleMissIds.push(deviceId);
    }
    for (const deviceId of staleMissIds) missByDeviceId.delete(deviceId);

    const snapshot: TransportDeviceSnapshot[] = [];
    const graceExceededIds: string[] = [];
    for (const previous of previousSnapshot) {
        const present = presentById.get(previous.id);
        if (present) {
            // Read succeeded this cycle: take the fresh entry, reset misses.
            missByDeviceId.delete(previous.id);
            snapshot.push(present);
            continue;
        }
        if (!networkFailedIds.has(previous.id)) {
            // Fetched fine but parsed out (unmanaged/unsupported/ineligible) — an
            // intentional removal. Drop immediately and clear any miss state.
            missByDeviceId.delete(previous.id);
            continue;
        }
        // Network miss this cycle: advance the consecutive-miss state.
        const prior = missByDeviceId.get(previous.id);
        const misses = (prior?.misses ?? 0) + 1;
        const firstMissMs = prior?.firstMissMs ?? nowMs;
        const graceExceeded = misses >= TARGETED_DEVICE_MISS_GRACE_READS
            && (nowMs - firstMissMs) >= TARGETED_DEVICE_MISS_GRACE_MS;
        if (graceExceeded) {
            // Genuine removal: drop from the snapshot (the caller prunes the
            // projection to match) and clear the counter as it leaves.
            missByDeviceId.delete(previous.id);
            graceExceededIds.push(previous.id);
            continue;
        }
        // Within grace: retain the prior entry, keep advancing the counter.
        missByDeviceId.set(previous.id, { misses, firstMissMs });
        snapshot.push(previous);
    }
    return { snapshot, graceExceededIds };
}

/**
 * Build the realtime-tracking device list for a targeted refresh: the freshly-
 * read present devices, plus the prior RAW entry for any committed (retained)
 * device absent from this cycle's read — so a retained device keeps its realtime
 * events and native adapters across the miss.
 */
export function overlayRetainedTrackedDevices(params: {
    effectiveList: HomeyDeviceLike[];
    committedSnapshot: readonly TargetDeviceSnapshot[];
    priorRawById: Map<string, HomeyDeviceLike>;
}): HomeyDeviceLike[] {
    const { effectiveList, committedSnapshot, priorRawById } = params;
    const presentIds = new Set(effectiveList.map((device) => getDeviceId(device)));
    const trackingList = [...effectiveList];
    for (const committed of committedSnapshot) {
        if (presentIds.has(committed.id)) continue;
        const priorRaw = priorRawById.get(committed.id);
        if (priorRaw) trackingList.push(priorRaw);
    }
    return trackingList;
}
