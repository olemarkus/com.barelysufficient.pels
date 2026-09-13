/**
 * A device as BOTH surfaces of the observer/transport split at once: its
 * descriptor (identity and config, transport-owned) joined with its observed
 * record (what it is doing, observer-owned). Stage 6 of the snapshot
 * decomposition (`notes/state-management/snapshot-decomposition.md`): this is
 * what the plan-input producer takes in place of the transport's raw snapshot.
 *
 * Each half is a PROJECTION — a fresh object carrying exactly its declared keys
 * (`projectDeviceDescriptor`, `projectObservedState`) — so the join carries the
 * union of the two declared surfaces and nothing else. That is the property the
 * carried-key gate on `toPlanDevice` (`PlanDeviceCarriedKey`) relies on: a
 * transport-internal field cannot ride the rest-spread onto a plan device,
 * because it is not on the object at all. The descriptor goes last so identity
 * is the transport's; the two halves share no other key.
 *
 * `lib/executor/executorDeviceRead.ts` performs the same join for the executor
 * from the same two owner reads; the `no-executor-to-device-internals` rule
 * forbids it this module, and one spread is not worth a third layer.
 *
 * (The phrasing above dodges a bare "import" on purpose: the packaging guard
 * `test/integration/runtimePackaging.test.ts` is a regex whose lazy body spans
 * newlines, so that word in a docblock above a type-only contracts import reads
 * as a value import and fails the build.)
 */
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
 * not, and an unmanaged device has no projection entry to join against. Same key
 * discipline as the join above, so a picker device fed to the plan-input producer
 * (the smart-task preview) is bounded the same way.
 */
export function projectDeviceSurfaces(snapshots: readonly TransportDeviceSnapshot[]): DeviceSurfaces[] {
    return snapshots.map((snapshot) => (
        joinDeviceSurfaces(projectDeviceDescriptor(snapshot), projectObservedState(snapshot))
    ));
}
