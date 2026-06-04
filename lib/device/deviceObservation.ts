import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

/**
 * Read-only view over the device snapshot store.
 *
 * Plan and executor read consumers depend on this interface rather than the
 * concrete `DeviceTransport` class, so the actuation transport half can move
 * later without rippling through every read site. See
 * `notes/state-management/observer-transport-split.md` for the larger plan.
 */
export type DeviceObservation = {
    /**
     * Returns the latest cached snapshot list. Callers must not mutate the
     * returned array or any entry.
     */
    getSnapshot(): TargetDeviceSnapshot[];

    /**
     * Returns the latest snapshot entry for a single device, or `undefined`
     * when the device is not tracked. Prefer this over
     * `getSnapshot().find(...)`.
     */
    getSnapshotByDeviceId(deviceId: string): TargetDeviceSnapshot | undefined;
};
