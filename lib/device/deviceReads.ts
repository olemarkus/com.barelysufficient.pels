/**
 * The one owner of "how you read devices out of the transport".
 *
 * Stage 7 of the snapshot decomposition (`notes/state-management/snapshot-decomposition.md`).
 * Every consumer outside `lib/device` used to reach the transport's cached array
 * directly — `getSnapshot()` — and take what it wanted from a ~58-field struct.
 * The reads it actually wanted are below, each named for the question it answers,
 * and the raw array reaches none of them: `AppContext` carries this surface and a
 * transport port with no `getSnapshot` on it, so there is nothing left to pull.
 *
 * It owns two things that were previously smeared across the callers:
 *
 * 1. **The projections.** A descriptor read serves `projectDeviceDescriptor`'s
 *    output and an observed read serves `projectObservedState`'s, so what a
 *    consumer receives physically carries its declared surface and nothing else.
 *    That is the property the plan input's carried-key gate stands on, and the
 *    one a merely-narrowed type cannot give (`deviceDescriptorProjection.ts`).
 * 2. **What an absent transport means** — decided per read, from the CALLER's
 *    context, not from the read's shape. The repo rule is "assert only where the
 *    caller can surface the error, and resolve where it cannot"
 *    (`setup/AGENTS.md`), so each read's docblock names the caller its answer was
 *    chosen for. Three answers are in use, and arity does not predict them: most
 *    list reads resolve to "no devices" (the target-power probe timer calls one
 *    before the transport exists and cannot throw); `descriptor(id)` asserts
 *    (it is the executor's, and "untracked device" there is a plan decided and
 *    silently never applied); `hasProductionCandidate()` asserts despite reading
 *    the whole corpus, because its caller's only alternative is to answer "this
 *    home produces nothing" and suppress production polling forever.
 *    Where two callers of one read would disagree, add the second form rather
 *    than picking for them.
 */
import type {
    DeviceDescriptorRead,
    ProjectedObservedDeviceState,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { projectDeviceDescriptor } from './deviceDescriptorProjection';
import { projectObservedState } from './observedStateProjection';
import { type DeviceSurfaces, joinDeviceSurfaces, projectDeviceSurfaces } from './deviceSurfaces';
import { hasSolarProductionCandidate } from './solarPresence';

/**
 * The transport slice these reads consume. Structural, so this module names no
 * class — and it is the ONLY declaration of the raw-list read outside the
 * transport itself, which is what makes `AppContext`'s port able to omit it.
 */
export type DeviceReadStore = {
    getSnapshot(): TransportDeviceSnapshot[];
    getSnapshotByDeviceId(id: string): TransportDeviceSnapshot | undefined;
    getUiPickerDevices(): TransportDeviceSnapshot[];
};

/** One device's home membership join key — `zoneId` is absent for an unzoned device. */
export type DeviceZoneMembership = {
    deviceId: string;
    zoneId: string | null;
};

export type DeviceReads = {
    /** Identity and config for every tracked device. Empty before the transport is wired. */
    descriptors(): DeviceDescriptorRead[];
    /** One device's descriptor, or `undefined` for an untracked id. Asserts the transport. */
    descriptor(deviceId: string): DeviceDescriptorRead | undefined;
    /**
     * Every tracked device as descriptor ⋈ observed record. Empty before the
     * transport is wired.
     *
     * COMPLETE by construction, and that is load-bearing: a device the observer
     * has no record for falls back to the observed state projected from the
     * snapshot itself — the same source and values the boot seed uses — rather
     * than being dropped. `syncHeadroomCardState` (`lib/plan/planHeadroomState.ts`)
     * is documented to take a complete snapshot and treats a device missing from
     * it as one that has LEFT THE HOME: it discards the device's held-time
     * accounting (the card's `Held 2 h` line), its surplus eligibility, its rung
     * tracking, and closes its activation attempt. Its caller
     * (`setup/appSnapshotHelpers.ts`) runs no seed of its own. Do not "simplify"
     * the fallback away on the grounds that the UI would only miss a row.
     */
    surfaces(): DeviceSurfaces[];
    /**
     * The by-id form of {@link DeviceReads.surfaces}. RESOLVES to `undefined`
     * before the transport is wired, unlike `descriptor(id)`: its caller is the
     * shed-behaviour thunk (`AppHostApi.getShedBehavior`), reached from plan
     * builds and the background objective clock, which already handle an absent
     * device and cannot surface a boot-order error usefully.
     */
    surface(deviceId: string): DeviceSurfaces | undefined;
    /**
     * The settings-UI picker list: a fresh parse of every Homey device, managed or
     * not. An unmanaged device has no observer record to join, so both halves are
     * projected from the parse itself — which keeps a picker device bounded exactly
     * like a tracked one when the smart-task preview feeds it to `toPlanDevice`.
     */
    pickerSurfaces(): DeviceSurfaces[];
    /**
     * Seed values for the observed-state projection's EMPTY slots
     * (`ObservedDeviceStateProjection.seedMissing`). The projection is event-fed, so
     * it holds nothing for a device until that device's first delta or refresh; this
     * is the same source and the same values, which is why a seed cannot disagree
     * with the record it stands in for.
     */
    observedSeed(): ProjectedObservedDeviceState[];
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
    getStore: () => DeviceReadStore | undefined;
    getObservedRecord: (deviceId: string) => ProjectedObservedDeviceState | undefined;
}): DeviceReads {
    const requireStore = (): DeviceReadStore => {
        const store = deps.getStore();
        if (!store) throw new Error('DeviceTransport must be initialized before reading devices');
        return store;
    };
    const observedFor = (snapshot: TransportDeviceSnapshot): ProjectedObservedDeviceState => (
        deps.getObservedRecord(snapshot.id) ?? projectObservedState(snapshot)
    );
    const surfaceOf = (snapshot: TransportDeviceSnapshot): DeviceSurfaces => (
        joinDeviceSurfaces(projectDeviceDescriptor(snapshot), observedFor(snapshot))
    );
    return {
        descriptors: () => (deps.getStore()?.getSnapshot() ?? []).map(projectDeviceDescriptor),
        descriptor: (deviceId) => {
            const snapshot = requireStore().getSnapshotByDeviceId(deviceId);
            return snapshot ? projectDeviceDescriptor(snapshot) : undefined;
        },
        surfaces: () => (deps.getStore()?.getSnapshot() ?? []).map(surfaceOf),
        surface: (deviceId) => {
            const snapshot = deps.getStore()?.getSnapshotByDeviceId(deviceId);
            return snapshot ? surfaceOf(snapshot) : undefined;
        },
        pickerSurfaces: () => projectDeviceSurfaces(deps.getStore()?.getUiPickerDevices() ?? []),
        observedSeed: () => (deps.getStore()?.getSnapshot() ?? []).map(projectObservedState),
        hasProductionCandidate: () => hasSolarProductionCandidate(requireStore().getSnapshot()),
        zoneMemberships: () => (deps.getStore()?.getSnapshot() ?? []).map((device) => ({
            deviceId: device.id,
            zoneId: device.zoneId ?? null,
        })),
        deviceIds: () => (deps.getStore()?.getSnapshot() ?? []).map((device) => device.id),
    };
}
