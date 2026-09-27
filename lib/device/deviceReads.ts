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
};

export function createDeviceReads(deps: {
    /** Lazy: the transport is wired during ordered startup, after this is built. */
    getStore: () => DeviceReadStore;
}): DeviceReads {
    return {
        descriptors: () => deps.getStore().getSnapshot().map(projectDeviceDescriptor),
        descriptor: (deviceId) => {
            const snapshot = deps.getStore().getSnapshotByDeviceId(deviceId);
            return snapshot ? projectDeviceDescriptor(snapshot) : undefined;
        },
        hasProductionCandidate: () => hasSolarProductionCandidate(deps.getStore().getSnapshot()),
        zoneMemberships: () => deps.getStore().getSnapshot().map((device) => ({
            deviceId: device.id,
            zoneId: device.zoneId ?? null,
        })),
        deviceIds: () => deps.getStore().getSnapshot().map((device) => device.id),
    };
}
