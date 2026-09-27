/**
 * Owns binary-settle evidence updates across realtime events and full refreshes.
 * Per `lib/device/AGENTS.md`, older full reads cannot roll back fresher
 * realtime/local-write evidence.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { BinaryControlObservation } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import { resolveEvCurrentOn, toCapabilityTimestampMs } from '../managerControl';
import { recordSnapshotCapabilityObservations } from './managerObservation';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import type { TransportObservationState } from './transportObservationState';


export function readCapabilityValue(device: HomeyDeviceLike, capabilityId: string | undefined): {
    present: boolean;
    value: unknown;
    observedAtMs?: number;
} {
    if (!capabilityId || !device.capabilitiesObj) return { present: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(device.capabilitiesObj, capabilityId)) {
        return { present: false, value: undefined };
    }
    const capability = device.capabilitiesObj[capabilityId];
    if (!Object.prototype.hasOwnProperty.call(capability ?? {}, 'value')) {
        return { present: false, value: undefined };
    }
    return {
        present: true,
        value: capability?.value,
        observedAtMs: toCapabilityTimestampMs(capability?.lastUpdated),
    };
}

export function resolveBinaryControlPayload(
    device: HomeyDeviceLike,
    snapshot: TransportDeviceSnapshot,
    previousSnapshot: TransportDeviceSnapshot | undefined,
): {
    present: boolean;
    capabilityId: TransportDeviceSnapshot['binaryCapabilityId'];
    observedCapabilityId: string;
    value: unknown;
    observedAtMs?: number;
} {
    const capabilityId = snapshot.binaryCapabilityId ?? previousSnapshot?.binaryCapabilityId;
    const observedCapabilityId = (
        snapshot.binaryObservationCapabilityId
        ?? previousSnapshot?.binaryObservationCapabilityId
        ?? capabilityId
    );
    if (!capabilityId || !observedCapabilityId) {
        return { present: false, capabilityId, observedCapabilityId: '', value: undefined };
    }
    return {
        capabilityId,
        observedCapabilityId,
        ...readCapabilityValue(device, observedCapabilityId),
    };
}

export class BinarySettleEvidenceService {
    constructor(
        private readonly snapshotStore: TransportSnapshotStore,
        private readonly observationState: TransportObservationState,
        private readonly logger: Logger,
        private readonly shouldTrackRealtimeDevice: (deviceId: string) => boolean,
    ) {}

    clearBinarySettleEvidence(deviceId: string): boolean {
    const removed = this.observationState.clearBinarySettleEvidence(deviceId);
    // By-id is authoritative; see the note in `deviceTransport.requestBinaryControl`.
    const snapshot = this.snapshotStore.getSnapshotIndex().get(deviceId);
    if (snapshot) delete snapshot.binaryControlObservation;
    return removed;
}
    clearInvalidControlPayload(
        deviceId: string,
        capabilityId: string,
    ): void {
    const existing = this.observationState.getBinarySettleEvidence(deviceId);
    if (!existing || existing.capabilityId !== capabilityId) return;
    this.clearBinarySettleEvidence(deviceId);
    this.logger.structuredLog.error({
        event: 'binary_settle_evidence_cleared',
        reasonCode: 'invalid_control_payload',
        deviceId,
        capabilityId,
        source: 'realtime_capability',
    });
}

    private upsertBinarySettleEvidence(
    deviceId: string,
    evidence: BinaryControlObservation,
): BinaryControlObservation {
    return this.observationState.upsertBinarySettleEvidence(deviceId, evidence);
}

    private applyBinarySettleEvidenceToSnapshot(
    snapshot: TransportDeviceSnapshot,
    evidence: BinaryControlObservation,
): BinaryControlObservation {
    const mutableSnapshot = snapshot;
    const acceptedEvidence = this.upsertBinarySettleEvidence(snapshot.id, evidence);
    if (acceptedEvidence.capabilityId === 'evcharger_charging') {
        const rawPermission = acceptedEvidence.observedCapabilityIds.includes('evcharger_charging');
        if (rawPermission) mutableSnapshot.evCharging = acceptedEvidence.observedValue;
        if (rawPermission) mutableSnapshot.evChargingObservedAtMs = acceptedEvidence.observedAtMs;
        mutableSnapshot.binaryControl = {
            on: resolveEvCurrentOn({
                evchargerCharging: mutableSnapshot.evCharging,
            }),
        };
    } else {
        mutableSnapshot.binaryControl = { on: acceptedEvidence.observedValue };
    }
    mutableSnapshot.binaryControlObservation = acceptedEvidence;
    return acceptedEvidence;
}
    private applyCachedBinarySettleEvidenceToSnapshot(
    snapshot: TransportDeviceSnapshot,
): void {
    const cached = this.observationState.getBinarySettleEvidence(snapshot.id);
    if (!cached) return;
    if (cached.capabilityId !== snapshot.binaryCapabilityId) return;
    this.applyBinarySettleEvidenceToSnapshot(snapshot, cached);
}

    private shouldClearBinarySettleEvidenceForSnapshot(
    snapshot: TransportDeviceSnapshot,
): boolean {
    return !this.shouldTrackRealtimeDevice(snapshot.id) || snapshot.managed === false;
}

    reconcileWithSnapshot(
    snapshot: TransportDeviceSnapshot[],
): void {
    const activeDeviceIds = new Set(snapshot.map((device) => device.id));
    this.observationState.retainBinarySettleEvidenceFor(activeDeviceIds);
    for (const device of snapshot) {
        if (this.shouldClearBinarySettleEvidenceForSnapshot(device)) {
            this.clearBinarySettleEvidence(device.id);
            delete device.binaryControlObservation;
            continue;
        }
        const evidence = device.binaryControlObservation;
        if (evidence) {
            this.applyBinarySettleEvidenceToSnapshot(device, evidence);
            continue;
        }
        this.applyCachedBinarySettleEvidenceToSnapshot(device);
    }
}
/* eslint-enable functional/immutable-data */

    applyFromDeviceUpdate(params: {
    deviceId: string;
    device: HomeyDeviceLike;
    snapshot: TransportDeviceSnapshot | null;
    previousSnapshot: TransportDeviceSnapshot | undefined;
}): void {
    const {
        deviceId,
        device,
        snapshot,
        previousSnapshot,
    } = params;
    if (!snapshot) {
        this.clearBinarySettleEvidence(deviceId);
        return;
    }
    const payload = resolveBinaryControlPayload(device, snapshot, previousSnapshot);
    if (!payload.capabilityId) return;
    // A conforming `device.update` carries a boolean with its stamp for the
    // binary capability it declares (the device-read contract); the guard is
    // for the type. Anything less is no new evidence.
    if (
        !payload.present
        || typeof payload.value !== 'boolean'
        || payload.observedAtMs === undefined
        || this.isOlderEvCommandObservation(payload, previousSnapshot)
    ) {
        this.applyCachedBinarySettleEvidenceToSnapshot(snapshot);
        return;
    }
    const evidence: BinaryControlObservation = {
        valid: true,
        capabilityId: payload.capabilityId,
        observedValue: payload.value,
        observedCapabilityIds: [payload.observedCapabilityId],
        observedAtMs: payload.observedAtMs,
        source: 'device_update',
    };
    this.applyBinarySettleEvidenceToSnapshot(snapshot, evidence);
}

private isOlderEvCommandObservation(
    payload: ReturnType<typeof resolveBinaryControlPayload>,
    previousSnapshot: TransportDeviceSnapshot | undefined,
): boolean {
    return payload.capabilityId === 'evcharger_charging'
        && payload.observedAtMs !== undefined
        && previousSnapshot?.evChargingObservedAtMs !== undefined
        && payload.observedAtMs <= previousSnapshot.evChargingObservedAtMs;
}

    applyBinaryObservationToSnapshot(
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: boolean,
    source: BinaryControlObservation['source'],
): void {
    const mutableSnapshot = snapshot;
    const observedAtMs = Date.now();
    if (capabilityId === 'evcharger_charging') {
        mutableSnapshot.evCharging = value;
        mutableSnapshot.evChargingObservedAtMs = observedAtMs;
        mutableSnapshot.binaryControl = {
            on: resolveEvCurrentOn({
                evchargerCharging: value,
            }),
        };
    } else {
        mutableSnapshot.binaryControl = { on: value };
    }
    if (capabilityId === 'onoff' || capabilityId === 'evcharger_charging') {
        const evidence: BinaryControlObservation = {
            valid: true,
            capabilityId,
            observedValue: value,
            observedCapabilityIds: [capabilityId],
            observedAtMs,
            source,
        };
        this.applyBinarySettleEvidenceToSnapshot(mutableSnapshot, evidence);
    }
}
/* eslint-enable functional/immutable-data */

    recordRealtimeCapabilityObservation(deviceId: string, capabilityIds: string[]): void {
    recordSnapshotCapabilityObservations({
        state: this.observationState.getObservationState(),
        latestSnapshot: this.snapshotStore.getSnapshot(),
        deviceId,
        source: 'realtime_capability',
        capabilityIds,
    });
}

}
