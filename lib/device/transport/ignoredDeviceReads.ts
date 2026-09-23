/**
 * The refresh side of the device-read contract (`deviceReadContract.ts`): split
 * a fetched list into the reads that conform and the ids whose read is
 * ignored, then put each ignored device's last conforming entry back, so an
 * ignored read is a no-op for the device rather than its removal.
 */
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceListRead } from '../deviceListRead';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { TransportContext } from './transportContext';
import { getLogger } from '../../logging/logger';
import { isIgnoredDeviceRead } from './deviceReadContract';
import { getDeviceId } from './managerHelpers';

const moduleLogger = getLogger('device/transport');

/**
 * Split a fetched list by the read contract (`deviceReadContract.ts`). The
 * ignored devices are named once per violation in the log and contribute
 * nothing from this read.
 */
export function partitionConformingDeviceReads(
    ctx: TransportContext,
    list: readonly HomeyDeviceLike[],
): DeviceListRead {
    const devices: HomeyDeviceLike[] = [];
    const ignoredIds = new Set<string>();
    const emitter = ctx.logger.structuredLog ?? moduleLogger;
    for (const device of list) {
        if (isIgnoredDeviceRead(ctx.owner, device, 'device_fetch', emitter)) ignoredIds.add(getDeviceId(device));
        else devices.push(device);
    }
    return { devices, ignoredIds };
}

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
export function withIgnoredReadRawDevices(ctx: TransportContext, read: DeviceListRead): HomeyDeviceLike[] {
    const { devices: conformingList, ignoredIds } = read;
    if (ignoredIds.size === 0) return conformingList;
    // The realtime tracking map first (it holds the newest conforming read of a
    // tracked device, a `device.update` included), then the last full raw list
    // (every device, managed or not, for the UI picker).
    const priorRawById = new Map(ctx.getLatestRawDevices().map((device) => [getDeviceId(device), device]));
    const trackedById = ctx.getTrackedDevicesById();
    const retained = [...ignoredIds].flatMap((deviceId) => {
        const prior = trackedById.get(deviceId) ?? priorRawById.get(deviceId);
        return prior === undefined ? [] : [prior];
    });
    return [...conformingList, ...retained];
}
