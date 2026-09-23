/**
 * Homey-free binary-settle evidence bookkeeping over `TransportContext`.
 * Per `lib/device/AGENTS.md`, older full reads cannot roll back fresher
 * realtime/local-write evidence; mutations target the passed context/snapshot.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { BinaryControlObservation } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import { resolveEvCurrentOn, toCapabilityTimestampMs } from '../managerControl';
import { recordSnapshotCapabilityObservations } from './managerObservation';
import type { ObservedDeviceStateEvent } from './managerRealtimeHandlers';
import { getLogger } from '../../logging/logger';
import { cloneBinaryControlObservation } from './transportTypes';
import type { TransportContext } from './transportContext';

const moduleLogger = getLogger('device/transport');
type SettleCursor = Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'>;

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

export function clearBinarySettleEvidence(ctx: TransportContext, deviceId: string): boolean {
    const removed = ctx.latestBinarySettleEvidenceByDeviceId.delete(deviceId);
    // By-id is authoritative; see the note in `deviceTransport.requestBinaryControl`.
    const snapshot = ctx.latestSnapshotById.get(deviceId);
    if (snapshot) delete snapshot.binaryControlObservation;
    return removed;
}
export function clearBinarySettleEvidenceForInvalidControlPayload(ctx: TransportContext, params: {
    deviceId: string;
    deviceName?: string;
    capabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
    source: BinaryControlObservation['source'];
    value: unknown;
}): void {
    const {
        deviceId,
        deviceName,
        capabilityId,
        source,
        value,
    } = params;
    if (!capabilityId) return;
    const existing = ctx.latestBinarySettleEvidenceByDeviceId.get(deviceId);
    if (!existing || existing.capabilityId !== capabilityId) return;
    clearBinarySettleEvidence(ctx, deviceId);
    (ctx.logger.structuredLog ?? moduleLogger).error({
        event: 'binary_settle_evidence_cleared',
        reasonCode: 'invalid_control_payload',
        deviceId,
        ...(deviceName ? { deviceName } : {}),
        capabilityId,
        source,
        valueType: typeof value,
    });
}

export function upsertBinarySettleEvidence(
    ctx: TransportContext,
    deviceId: string,
    evidence: BinaryControlObservation,
): BinaryControlObservation {
    const existing = ctx.latestBinarySettleEvidenceByDeviceId.get(deviceId);
    if (existing && existing.observedAtMs > evidence.observedAtMs) {
        return cloneBinaryControlObservation(existing);
    }
    const next = cloneBinaryControlObservation(evidence);
    ctx.latestBinarySettleEvidenceByDeviceId.set(deviceId, next);
    return next;
}

export function applyBinarySettleEvidenceToSnapshot(
    ctx: TransportContext,
    snapshot: TransportDeviceSnapshot,
    evidence: BinaryControlObservation,
): BinaryControlObservation {
    const mutableSnapshot = snapshot;
    const acceptedEvidence = upsertBinarySettleEvidence(ctx, snapshot.id, evidence);
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
export function applyCachedBinarySettleEvidenceToSnapshot(
    ctx: TransportContext,
    snapshot: TransportDeviceSnapshot,
): void {
    const cached = ctx.latestBinarySettleEvidenceByDeviceId.get(snapshot.id);
    if (!cached) return;
    if (cached.capabilityId !== snapshot.binaryCapabilityId) return;
    applyBinarySettleEvidenceToSnapshot(ctx, snapshot, cached);
}

export function shouldClearBinarySettleEvidenceForSnapshot(
    ctx: TransportContext,
    snapshot: TransportDeviceSnapshot,
): boolean {
    return !ctx.shouldTrackRealtimeDevice(snapshot.id) || snapshot.managed === false;
}

export function reconcileBinarySettleEvidenceWithSnapshot(
    ctx: TransportContext,
    snapshot: TransportDeviceSnapshot[],
): void {
    const activeDeviceIds = new Set(snapshot.map((device) => device.id));
    for (const deviceId of ctx.latestBinarySettleEvidenceByDeviceId.keys()) {
        if (!activeDeviceIds.has(deviceId)) ctx.latestBinarySettleEvidenceByDeviceId.delete(deviceId);
    }
    for (const device of snapshot) {
        if (shouldClearBinarySettleEvidenceForSnapshot(ctx, device)) {
            clearBinarySettleEvidence(ctx, device.id);
            delete device.binaryControlObservation;
            continue;
        }
        const evidence = device.binaryControlObservation;
        if (evidence) {
            applyBinarySettleEvidenceToSnapshot(ctx, device, evidence);
            continue;
        }
        applyCachedBinarySettleEvidenceToSnapshot(ctx, device);
    }
}

export function applyBinarySettleEvidenceFromDeviceUpdate(ctx: TransportContext, params: {
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
        clearBinarySettleEvidence(ctx, deviceId);
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
        || isOlderEvCommandObservation(payload, previousSnapshot)
    ) {
        applyCachedBinarySettleEvidenceToSnapshot(ctx, snapshot);
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
    applyBinarySettleEvidenceToSnapshot(ctx, snapshot, evidence);
}

function isOlderEvCommandObservation(
    payload: ReturnType<typeof resolveBinaryControlPayload>,
    previousSnapshot: TransportDeviceSnapshot | undefined,
): boolean {
    return payload.capabilityId === 'evcharger_charging'
        && payload.observedAtMs !== undefined
        && previousSnapshot?.evChargingObservedAtMs !== undefined
        && payload.observedAtMs <= previousSnapshot.evChargingObservedAtMs;
}

export function applyBinaryObservationToSnapshot(
    ctx: TransportContext,
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
        applyBinarySettleEvidenceToSnapshot(ctx, mutableSnapshot, evidence);
    }
}

export function recordRealtimeCapabilityObservation(ctx: TransportContext, params: {
    deviceId: string;
    eventCapabilityId: string;
    observedCapabilityIds: string[];
}, deferObservedEvent = false, cursor?: SettleCursor): void {
    const { deviceId, eventCapabilityId, observedCapabilityIds } = params;
    recordSnapshotCapabilityObservations({
        state: ctx.observationState,
        latestSnapshot: ctx.latestSnapshot,
        deviceId,
        source: 'realtime_capability',
        capabilityIds: observedCapabilityIds,
    });
    if (deferObservedEvent) return;
    ctx.dispatchObservedStateChanged({
        source: 'realtime_capability',
        deviceId,
        ...(cursor ?? ctx.nextObservationCursor(deviceId)),
        capabilityId: eventCapabilityId,
    });
}
