/**
 * Pure projection from the full transport snapshot down to the descriptor
 * surface (`DeviceDescriptorRead`): identity and config, no observations. The
 * sibling of `projectObservedState` (`observedStateProjection.ts`), and stage 5
 * of the snapshot decomposition (`notes/state-management/snapshot-decomposition.md`)
 * is why it exists: the executor joins a descriptor with the observer's record
 * by spread, and a spread copies every key the object PHYSICALLY carries. A
 * descriptor that was merely the snapshot under a narrower type would hand the
 * executor the transport's live observed fields through the back door, so the
 * declared surface has to be the physical one.
 *
 * Copies exactly the keys of `DeviceDescriptorRead`, only when defined, and
 * nothing else. The key list is a `Record<keyof DeviceDescriptorRead, true>`
 * literal, so adding a field to `DeviceDescriptor` (or the stepped-descriptor
 * probe) without listing it here is a compile error, and so is listing a key the
 * type does not have.
 *
 * Nested descriptor values (`controlModel`, `capabilities`, the ladders) are
 * aliased, not copied: transport REPLACES them at parse and never mutates them
 * in place — the in-place mutators (`transport/observationApply.ts` and its
 * neighbours) all write observed fields, which this projection does not carry.
 */
import type { DeviceDescriptorRead } from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';

/**
 * The snapshot store as these reads see it — the two lookups `DeviceTransport`
 * exposes, and nothing else. Structural so this module never names the concrete
 * class.
 *
 * Typed `TransportDeviceSnapshot`, not `TargetDeviceSnapshot`: `readDeviceSurfaces`
 * projects the OBSERVED half out of these same objects when the observer has no
 * record, and the observed clusters it reads (`temperature`, `stateOfCharge`,
 * `measuredPowerKw`, `evChargingState`, `reportedStepId`) live on the probes, not
 * on the base type. Declared as the base it would compile anyway — every probe
 * member is optional — and work only because the object happens to be physically
 * wider, which is the failure this file's own header warns about.
 */
export type DeviceSnapshotStore = {
    getSnapshot(): TransportDeviceSnapshot[];
    getSnapshotByDeviceId(id: string): TransportDeviceSnapshot | undefined;
};

// A record keyed by EVERY descriptor key: TypeScript refuses the literal when a
// key of `DeviceDescriptorRead` is missing, and refuses an extra key it does not
// have, so this object is the complete key set and nothing else can be.
const DESCRIPTOR_KEY_RECORD: Record<keyof DeviceDescriptorRead, true> = {
    id: true,
    name: true,
    deviceClass: true,
    deviceType: true,
    zone: true,
    zoneId: true,
    controlModel: true,
    controlAdapter: true,
    binaryControllable: true,
    deviceRole: true,
    suggestedSteppedLoadProfile: true,
    nativeWriteCapabilities: true,
    flowConflict: true,
    flowBacked: true,
    capabilities: true,
    canSetControl: true,
    powerCapable: true,
    controllable: true,
    managed: true,
    budgetExempt: true,
    priority: true,
    expectedPowerKw: true,
    expectedPowerSource: true,
    steppedLoadProfile: true,
    targetPowerConfig: true,
};
const DESCRIPTOR_KEYS = Object.keys(DESCRIPTOR_KEY_RECORD) as (keyof DeviceDescriptorRead)[];

/**
 * The descriptor reads themselves — surface 2 of the observer/transport split,
 * owned here in `lib/device` so the wiring layer only delegates
 * (`setup/AGENTS.md` § "No domain logic"). They would sit on `DeviceTransport`
 * beside `getSnapshot`, but that class is at its 500-line cap; this is the stage
 * 7 home regardless, since sealing `getSnapshot()` leaves these as the
 * descriptor's only exit.
 */
export function readDeviceDescriptors(store: DeviceSnapshotStore): DeviceDescriptorRead[] {
    return projectDeviceDescriptors(store.getSnapshot());
}

/** The list form of the projection, for a caller already holding a snapshot list. */
export function projectDeviceDescriptors(snapshots: readonly DeviceDescriptorRead[]): DeviceDescriptorRead[] {
    return snapshots.map(projectDeviceDescriptor);
}

export function readDeviceDescriptor(store: DeviceSnapshotStore, deviceId: string): DeviceDescriptorRead | undefined {
    const snapshot = store.getSnapshotByDeviceId(deviceId);
    return snapshot ? projectDeviceDescriptor(snapshot) : undefined;
}

export function projectDeviceDescriptor(source: DeviceDescriptorRead): DeviceDescriptorRead {
    const descriptor: DeviceDescriptorRead = {
        id: source.id,
        name: source.name,
        expectedPowerKw: source.expectedPowerKw,
        expectedPowerSource: source.expectedPowerSource,
    };
    // Generic over the key so the assignment type-checks per key rather than
    // across the union of every descriptor value type.
    const copyDefined = <K extends keyof DeviceDescriptorRead>(key: K): void => {
        const value = source[key];
        if (value !== undefined) descriptor[key] = value;
    };
    for (const key of DESCRIPTOR_KEYS) copyDefined(key);
    return descriptor;
}
