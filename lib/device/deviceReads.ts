/** Inventory metadata reads. Runtime state is owned by Observer. */
import type {
    DeviceDescriptorRead,
} from '../../packages/contracts/src/types';

import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { projectDeviceDescriptor } from './deviceDescriptorProjection';
import { hasSolarProductionCandidate } from './solarPresence';

/**
 * The transport slice these reads consume. Structural, so this module names no
 * class — and it is the ONLY declaration of the raw-list read outside the
 * transport itself, which is what makes `AppContext`'s port able to omit it.
 */
export type DeviceReadStore = {
    getSnapshot(): TransportDeviceSnapshot[];
    getSnapshotByDeviceId(id: string): TransportDeviceSnapshot | undefined;
    getHomeyDeviceIds(): ReadonlySet<string>;
};

/** One device's home membership join key — `zoneId` is absent for an unzoned device. */
export type DeviceZoneMembership = {
    deviceId: string;
    zoneId: string | null;
};

export type DeviceReads = {
    /** Identity and configuration metadata for tracked devices. */
    descriptors(): DeviceDescriptorRead[];
    /** One device's descriptor, or `undefined` for an untracked id. */
    descriptor(deviceId: string): DeviceDescriptorRead | undefined;
    /**
     * Is any tracked device a PV production candidate? Allocation-free on purpose:
     * the generation poll runs every 10 s on every flow home, and the question needs
     * only `deviceClass` — projecting each device to ask it would allocate the whole
     * device list per tick on the path the memory watchdog watches.
     */
    hasProductionCandidate(): boolean;

    /** The device→zone join multi-home membership recomputes from. Two fields, no projection. */
    zoneMemberships(): DeviceZoneMembership[];
    /** Every tracked device id, for a caller building a per-device map. */
    deviceIds(): string[];
    /**
     * Run `prune` with every device in Homey's last full device list, tracked or
     * not: a device PELS cannot read or control right now is still listed, and
     * per-device data is dropped only for a device missing from it. Nothing is
     * gone before Homey has listed any device, so `prune` does not run then.
     */
    pruneToHomeyDevices(prune: (homeyDeviceIds: ReadonlySet<string>) => void): void;
};

export function createDeviceReads(getStore: () => DeviceReadStore): DeviceReads {
    return {
        descriptors: () => getStore().getSnapshot().map(projectDeviceDescriptor),
        descriptor: (deviceId) => {
            const snapshot = getStore().getSnapshotByDeviceId(deviceId);
            return snapshot ? projectDeviceDescriptor(snapshot) : undefined;
        },
        hasProductionCandidate: () => hasSolarProductionCandidate(getStore().getSnapshot()),
        zoneMemberships: () => getStore().getSnapshot().map((device) => ({
            deviceId: device.id,
            zoneId: device.zoneId ?? null,
        })),
        deviceIds: () => getStore().getSnapshot().map((device) => device.id),
        pruneToHomeyDevices: (prune) => {
            const homeyDeviceIds = getStore().getHomeyDeviceIds();
            if (homeyDeviceIds.size > 0) prune(homeyDeviceIds);
        },
    };
}
