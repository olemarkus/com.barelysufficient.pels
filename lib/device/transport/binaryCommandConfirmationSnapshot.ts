import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { PendingBinaryLiveDevice } from '../../ports/controlCommandConfirmation';

function projectBinaryCommandConfirmation(
    device: TransportDeviceSnapshot,
): PendingBinaryLiveDevice['binaryCommandConfirmation'] {
    const observation = device.binaryControlObservation;
    const confirmationCapabilityId = device.binaryObservationCapabilityId
        ?? device.binaryCapabilityId;
    if (
        !observation
        || !confirmationCapabilityId
        || !observation.observedCapabilityIds.includes(confirmationCapabilityId)
    ) {
        return { state: 'unavailable' };
    }
    return {
        state: 'observed',
        observedValue: observation.observedValue,
        observedAtMs: observation.observedAtMs,
    };
}

export function buildBinaryCommandConfirmationSnapshot(
    snapshot: TransportDeviceSnapshot[],
): PendingBinaryLiveDevice[] {
    return snapshot.map((device) => ({
        id: device.id,
        name: device.name,
        binaryCommandConfirmation: projectBinaryCommandConfirmation(device),
    }));
}
