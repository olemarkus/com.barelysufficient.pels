/**
 * The refresh side of the device-read contract (`deviceReadContract.ts`): split
 * a fetched list into the reads that conform and the ids whose read is
 * ignored, then put each ignored device's last conforming entry back, so an
 * ignored read is a no-op for the device rather than its removal.
 */
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceListRead } from '../deviceListRead';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { Logger } from '../../utils/types';
import { resolveDeviceRead } from './deviceReadContract';
import { getDeviceId } from './managerHelpers';
import type { TransportSnapshotStore } from './transportSnapshotStore';

/**
 * Each device's last accepted raw read: the realtime tracking map first (it
 * holds the newest accepted read of a tracked device, a `device.update`
 * included), then the last full raw list (every device, managed or not).
 */
export function lastAcceptedRawDevicesById(store: TransportSnapshotStore): ReadonlyMap<string, HomeyDeviceLike> {
    return new Map([
        ...store.getLatestRawDevices().map((device) => [getDeviceId(device), device] as const),
        ...store.getTrackedRawDevicesById(),
    ]);
}

/** One device's last accepted raw read, by the same order. */
export function lastAcceptedRawDevice(store: TransportSnapshotStore, deviceId: string): HomeyDeviceLike | undefined {
    return store.getTrackedRawDevice(deviceId)
        ?? store.getLatestRawDevices().find((device) => getDeviceId(device) === deviceId);
}

/**
 * Split a fetched list by the read contract (`deviceReadContract.ts`). The
 * ignored devices are named once per violation in the log and contribute
 * nothing from this read; the others are kept as the contract resolved them,
 * with any `null` model capability withheld.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function partitionConformingDeviceReads(
    store: TransportSnapshotStore,
    logger: Logger,
    list: readonly HomeyDeviceLike[],
): DeviceListRead {
    const devices: HomeyDeviceLike[] = [];
    const ignoredIds = new Set<string>();
    const emitter = logger.structuredLog;
    const previousById = lastAcceptedRawDevicesById(store);
    for (const device of list) {
        const read = resolveDeviceRead(store, device, previousById.get(getDeviceId(device)), 'device_fetch', emitter);
        if (read === null) ignoredIds.add(getDeviceId(device));
        else devices.push(read);
    }
    return { devices, ignoredIds };
}
/* eslint-enable functional/immutable-data */

// An ignored read is a no-op for the device: the entry it had before this read
// stands. A device PELS had never parsed has no entry and stays out until a read
// of it conforms.
export function withIgnoredReadEntries(
    parsed: TransportDeviceSnapshot[],
    previousSnapshot: readonly TransportDeviceSnapshot[],
    ignoredIds: ReadonlySet<string>,
): TransportDeviceSnapshot[] {
    if (ignoredIds.size === 0) return parsed;
    return [...parsed, ...previousSnapshot.filter((device) => ignoredIds.has(device.id))];
}

// The same for the raw device the tracking map and the UI picker hold: the last
// conforming read of an ignored device, never the payload that was ignored.
export function withIgnoredReadRawDevices(
    trackedById: ReadonlyMap<string, HomeyDeviceLike>,
    latestRawDevices: readonly HomeyDeviceLike[],
    read: DeviceListRead,
): HomeyDeviceLike[] {
    const { devices: conformingList, ignoredIds } = read;
    if (ignoredIds.size === 0) return conformingList;
    // The realtime tracking map first (it holds the newest conforming read of a
    // tracked device, a `device.update` included), then the last full raw list
    // (every device, managed or not, for the UI picker).
    const priorRawById = new Map(latestRawDevices.map((device) => [getDeviceId(device), device]));
    const retained = [...ignoredIds].flatMap((deviceId) => {
        const prior = trackedById.get(deviceId) ?? priorRawById.get(deviceId);
        return prior === undefined ? [] : [prior];
    });
    return [...conformingList, ...retained];
}
