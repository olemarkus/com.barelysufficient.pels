import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';

export type BinaryCommandConfirmationDevice = {
    id: string;
    name: string;
    binaryCommandConfirmation:
      | { state: 'unavailable' }
      | {
        state: 'observed';
        observedValue: boolean;
        observedAtMs: number;
      };
};

function projectBinaryCommandConfirmation(
    device: TransportDeviceSnapshot,
): BinaryCommandConfirmationDevice['binaryCommandConfirmation'] {
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
): BinaryCommandConfirmationDevice[] {
    return snapshot.map((device) => ({
        id: device.id,
        name: device.name,
        binaryCommandConfirmation: projectBinaryCommandConfirmation(device),
    }));
}
