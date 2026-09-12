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
import { type DeviceSnapshotStore, projectDeviceDescriptor } from './deviceDescriptorProjection';
import { projectObservedState } from './observedStateProjection';

export type DeviceSurfaces = DeviceDescriptorRead & ProjectedObservedDeviceState;

export function joinDeviceSurfaces(
    descriptor: DeviceDescriptorRead,
    observed: ProjectedObservedDeviceState,
): DeviceSurfaces {
    return { ...observed, ...descriptor };
}

/**
 * Every tracked device, in snapshot order, as its descriptor joined with the
 * observer's record.
 *
 * A device the observer has no record for falls back to the observed state
 * projected from the snapshot itself — the same source and the same values the
 * boot seed uses (`seedMissing`), which is why the fallback cannot disagree with
 * the record it stands in for. It is NOT dropped, and that is the one place this
 * read deliberately differs from the executor's
 * (`lib/executor/executorDeviceRead.ts`, which drops). The asymmetry is the
 * consequence: for the executor, no observation means do not command this device
 * — safe by default. Here a drop would be destructive. `syncHeadroomCardState`
 * (`lib/plan/planHeadroomState.ts`) is documented to take a COMPLETE snapshot and
 * treats a device missing from it as one that has left the home: it drops the
 * device's held-time accounting (the card's `Held 2 h` line), its surplus
 * eligibility, its rung tracking, and closes its activation attempt. Its caller
 * (`setup/appSnapshotHelpers.ts`) reads this view and runs no seed of its own —
 * only the plan pre-pass does (`setup/homeRuntime/planDevicePrePass.ts`). So
 * completeness here is load-bearing well beyond the device list the owner sees.
 *
 * Three things produce a record, and a device can be tracked without one for a
 * whole poll interval anyway: the bootstrap refresh batch, the boot/hot-plug seed,
 * and the realtime push — but a hot-plug whose first `device.update` reconciles to
 * no control-state change and no temperature / state-of-charge facet emits no
 * observation event at all (`lib/device/managerRuntime.ts` appends it to the
 * snapshot regardless).
 */
export function readDeviceSurfaces(
    store: DeviceSnapshotStore,
    getObserved: (deviceId: string) => ProjectedObservedDeviceState | undefined,
): DeviceSurfaces[] {
    return store.getSnapshot().map((snapshot) => joinDeviceSurfaces(
        projectDeviceDescriptor(snapshot),
        getObserved(snapshot.id) ?? projectObservedState(snapshot),
    ));
}

/** The by-id form of {@link readDeviceSurfaces}, for a caller that needs one device. */
export function readDeviceSurface(
    store: DeviceSnapshotStore,
    getObserved: (deviceId: string) => ProjectedObservedDeviceState | undefined,
    deviceId: string,
): DeviceSurfaces | undefined {
    const snapshot = store.getSnapshotByDeviceId(deviceId);
    if (!snapshot) return undefined;
    return joinDeviceSurfaces(
        projectDeviceDescriptor(snapshot),
        getObserved(deviceId) ?? projectObservedState(snapshot),
    );
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
