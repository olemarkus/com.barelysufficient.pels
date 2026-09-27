/** Cached picker rows for unmanaged devices, which have no Observer record. */
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
export type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { projectDeviceDescriptor } from './deviceDescriptorProjection';
import { projectObservedState } from './observedStateProjection';

/**
 * Both surfaces projected from parsed devices the observer does not track: the
 * settings-UI picker list is a fresh parse of every Homey device, managed or
 * not, and an unmanaged device has no observation entry to join against. Picker
 * devices remain inventory metadata; planner inputs are joined from
 * DeviceConfiguration and Observer records.
 */
export function projectDeviceSurfaces(snapshots: readonly TransportDeviceSnapshot[]): DeviceSurfaces[] {
    return snapshots.map((snapshot) => ({
        ...projectObservedState(snapshot),
        ...projectDeviceDescriptor(snapshot),
    }));
}
