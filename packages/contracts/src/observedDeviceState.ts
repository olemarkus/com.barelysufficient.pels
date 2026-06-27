import type { ObservedDeviceState } from './types.js';

/**
 * One device's entry in a full-snapshot-refresh batch: the per-device cursor
 * (so the observer projection's sequenced guard supersedes in-flight deltas)
 * plus the decided observed value. Stage 4a of the snapshot decomposition.
 *
 * Lives in shared contracts so the device-side event type
 * (`ObservedDeviceStateRefreshEvent`) and the observer-side mirror
 * (`ObservedStateRefreshEvent`) share one definition rather than being
 * hand-kept in sync across the `lib/device/` ↔ `lib/observer/` boundary.
 */
export type ObservedDeviceStateRefreshEntry = {
    observationSeq: number;
    observedAtMs: number;
    observed: ObservedDeviceState;
};

/**
 * Batch payload for a snapshot refresh — one entry per committed device. The
 * committed snapshot is always complete truth for the known device set (a full
 * read, or a targeted overlay with the per-device miss grace already applied),
 * so the projection prunes devices absent from the batch unconditionally.
 */
export type ObservedDeviceStateRefreshPayload = {
    entries: ObservedDeviceStateRefreshEntry[];
};
