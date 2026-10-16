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
import { resolveDeviceRead, type LastAcceptedCapabilityEntry } from './deviceReadContract';
import { toCapabilityTimestampMs } from '../managerControl';
import { buildCapabilityObservationKey, type DeviceTransportObservationState } from './observationState';
import { getDeviceId } from './managerHelpers';
import type { TransportSnapshotStore } from './transportSnapshotStore';

/**
 * The newest accepted entry for one of the device's capabilities: its last
 * accepted raw read's entry (looked up only when a `null` asks for it), or a later observation the device itself
 * reported (a realtime capability event updates no raw read). A local write
 * the device has not reported is not a reading of it. The contract checks the
 * entry before it stands in for a `null`, so a retained rejection never does.
 */
export function lastAcceptedCapabilityEntries(
    readPrevious: () => HomeyDeviceLike | undefined,
    observations: DeviceTransportObservationState,
    deviceId: string,
): LastAcceptedCapabilityEntry {
    return (capabilityId) => {
        const previous = readPrevious();
        const raw = previous?.capabilities?.includes(capabilityId) === true
            ? previous.capabilitiesObj?.[capabilityId]
            : undefined;
        const observed = observations.capabilityObservations.get(buildCapabilityObservationKey(deviceId, capabilityId));
        if (observed === undefined || observed.source === 'local_write') return raw;
        const rawObservedAt = toCapabilityTimestampMs(raw?.lastUpdated);
        if (rawObservedAt !== undefined && rawObservedAt >= observed.observedAt) return raw;
        return { ...raw, value: observed.value, lastUpdated: new Date(observed.observedAt).toISOString() };
    };
}

/**
 * Split a fetched list by the read contract (`deviceReadContract.ts`). The
 * ignored devices are named once per violation in the log and contribute
 * nothing from this read; the others are kept as the contract resolved them,
 * with each `null` model capability resolved.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function partitionConformingDeviceReads(
    store: TransportSnapshotStore,
    observations: DeviceTransportObservationState,
    logger: Logger,
    list: readonly HomeyDeviceLike[],
): DeviceListRead {
    const devices: HomeyDeviceLike[] = [];
    const ignoredIds = new Set<string>();
    const emitter = logger.structuredLog;
    const previousById = store.getLastAcceptedRawDevicesById();
    for (const device of list) {
        const deviceId = getDeviceId(device);
        const lastAccepted = lastAcceptedCapabilityEntries(() => previousById.get(deviceId), observations, deviceId);
        const read = resolveDeviceRead(store, device, lastAccepted, 'device_fetch', emitter);
        if (read === null) ignoredIds.add(deviceId);
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
    store: TransportSnapshotStore,
    read: DeviceListRead,
): HomeyDeviceLike[] {
    const { devices: conformingList, ignoredIds } = read;
    if (ignoredIds.size === 0) return conformingList;
    const priorRawById = store.getLastAcceptedRawDevicesById();
    const retained = [...ignoredIds].flatMap((deviceId) => {
        const prior = priorRawById.get(deviceId);
        return prior === undefined ? [] : [prior];
    });
    return [...conformingList, ...retained];
}
