/** Cached picker rows for unmanaged devices, which have no Observer record. */
import type {
    DeviceDescriptorRead,
    ProjectedObservedDeviceState,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { projectDeviceDescriptor } from './deviceDescriptorProjection';
import { projectObservedState } from './observedStateProjection';

export type DeviceSurfaces = DeviceDescriptorRead & ProjectedObservedDeviceState;

export function joinDeviceSurfaces(
    descriptor: DeviceDescriptorRead,
    observed: ProjectedObservedDeviceState,
): DeviceSurfaces {
    return { ...observed, ...descriptor };
}

/**
 * Both surfaces projected from parsed devices the observer does not track: the
 * settings-UI picker list is a fresh parse of every Homey device, managed or
 * not, and an unmanaged device has no observation entry to join against. Picker
 * devices remain inventory metadata; planner inputs are joined from
 * DeviceConfiguration and Observer records.
 */
export function projectDeviceSurfaces(snapshots: readonly TransportDeviceSnapshot[]): DeviceSurfaces[] {
    return snapshots.map((snapshot) => (
        joinDeviceSurfaces(projectDeviceDescriptor(snapshot), projectObservedState(snapshot))
    ));
}
