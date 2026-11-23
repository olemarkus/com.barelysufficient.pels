import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { normalizeTargetCapabilityValue } from '../../../packages/shared-domain/src/targetCapabilities';
import type { NativeRelayBinding, NativeRelayOffResult } from '../../ports/nativeRelay';
import type { EvCarLinkProducer } from '../evCarLinkProducer';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceWriteService } from './deviceWrites';
import { resolveNativeRelayBinding, writeNativeRelayOff } from './nativeRelay';
import { hasAcceptedBinarySwitch } from './binarySwitchBinding';
import { hasObservedMeasuredPower } from '../../../packages/shared-domain/src/measuredPowerObservedState';
export { buildBinaryCommandConfirmationSnapshot } from './binaryCommandConfirmationSnapshot';

export function resolveTemperatureTarget(
    snapshot: TransportDeviceSnapshot[],
    deviceId: string,
    desired: number,
): number {
    const target = snapshot.find((entry) => entry.id === deviceId)
        ?.targets.find((entry) => entry.id.startsWith('target_temperature'));
    if (!target) throw new Error(`No temperature target binding for device ${deviceId}`);
    return normalizeTargetCapabilityValue({ target, value: desired });
}

export function readNativeRelayBinding(
    store: TransportSnapshotStore, deviceId: string,
): NativeRelayBinding | undefined {
    return resolveNativeRelayBinding(store.getSnapshotByDeviceId(deviceId), store.getLastAcceptedRawDevice(deviceId));
}

function allowsCurrentLastResortSwitch(
    store: TransportSnapshotStore, snapshot: TransportDeviceSnapshot | undefined, raw: HomeyDeviceLike | undefined,
): boolean {
    const observation = snapshot?.binaryControlObservation;
    return snapshot?.available === true && raw?.available === true && snapshot.canSetControl === true
        && observation !== undefined && observation.capabilityId === snapshot.binaryCapabilityId
        && snapshot.binaryControl?.on === observation.observedValue
        && hasAcceptedBinarySwitch(raw, observation.capabilityId, observation.observedValue)
        && !store.externalPower?.sourceForDevice(snapshot.id)
        && (observation.observedValue === false || !hasObservedMeasuredPower(snapshot));
}

/** Resolve the switch from the current binding at dispatch, including its accepted Flow routing. */
// eslint-disable-next-line max-params -- Preserve optional authority values on the existing transport seam.
export async function requestBinaryControl(
    store: TransportSnapshotStore,
    writes: DeviceWriteService,
    evCarLink: EvCarLinkProducer,
    deviceId: string,
    desired: boolean,
    triggerFlow: (id: string, capabilityId: string, desired: boolean) => Promise<void>,
    binarySwitchGeneration?: number,
    lastResortMaximumW?: number,
): Promise<NativeRelayOffResult | void | false> {
    if (!store.binarySwitches.allows(deviceId, binarySwitchGeneration)
        || !store.binarySwitches.allowsLastResortWrite(deviceId, lastResortMaximumW)) return false;
    const raw = store.getTrackedRawDevice(deviceId);
    store.externalPower?.assertAllowsWrite(deviceId);
    const snapshot = store.getSnapshotByDeviceId(deviceId);
    if (lastResortMaximumW !== undefined && !allowsCurrentLastResortSwitch(store, snapshot, raw)) return false;
    const capabilityId = snapshot?.binaryCapabilityId;
    if (!capabilityId) throw new Error(`No binary control binding for device ${deviceId}`);
    // Even a stop routed to a current limit is PELS's stop when matching a later car-link event.
    if (!desired) evCarLink.noteStopCommand(deviceId, Date.now());
    if (snapshot.flowBackedCapabilityIds?.includes(capabilityId)) {
        if (desired && !writes.canTurnOnDevice(deviceId)) throw new Error('Device is not ready to start.');
        await triggerFlow(deviceId, capabilityId, desired);
        return undefined;
    }
    const write = () => writes.setCapability(deviceId, capabilityId, desired);
    const relay = desired ? undefined : resolveNativeRelayBinding(snapshot, store.getLastAcceptedRawDevice(deviceId));
    if (relay) return writeNativeRelayOff(relay, write);
    await write();
    return undefined;
}
