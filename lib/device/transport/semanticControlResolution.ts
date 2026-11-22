import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { normalizeTargetCapabilityValue } from '../../../packages/shared-domain/src/targetCapabilities';
import type { NativeRelayBinding, NativeRelayOffResult } from '../../ports/nativeRelay';
import type { EvCarLinkProducer } from '../evCarLinkProducer';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import type { DeviceWriteService } from './deviceWrites';
import { resolveNativeRelayBinding, writeNativeRelayOff } from './nativeRelay';
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

/** Resolve the switch from the current binding at dispatch, including its accepted Flow routing. */
export async function requestBinaryControl(
    store: TransportSnapshotStore,
    writes: DeviceWriteService,
    evCarLink: EvCarLinkProducer,
    deviceId: string,
    desired: boolean,
    triggerFlow: (id: string, capabilityId: string, desired: boolean) => Promise<void>,
    binarySwitchGeneration?: number,
): Promise<NativeRelayOffResult | void | false> {
    if (!store.binarySwitches.allows(deviceId, binarySwitchGeneration)) return false;
    store.externalPower?.assertAllowsWrite(deviceId);
    const snapshot = store.getSnapshotByDeviceId(deviceId);
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
