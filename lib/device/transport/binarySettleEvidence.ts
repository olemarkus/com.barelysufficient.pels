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
import { getDeviceId } from './managerHelpers';
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

export function hasInvalidBinaryControlPayload(snapshot: TransportDeviceSnapshot, device: HomeyDeviceLike): boolean {
    if (!snapshot.binaryCapabilityId) return false;
    const observedCapabilityId = snapshot.binaryObservationCapabilityId ?? snapshot.binaryCapabilityId;
    const payload = readCapabilityValue(device, observedCapabilityId);
    return payload.present && typeof payload.value !== 'boolean';
}

export function clearBinarySettleEvidence(ctx: TransportContext, deviceId: string): boolean {
    const removed = ctx.latestBinarySettleEvidenceByDeviceId.delete(deviceId);
    const snapshot = ctx.latestSnapshotById.get(deviceId)
        ?? ctx.latestSnapshot.find((device) => device.id === deviceId);
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

export function clearContradictoryBinarySettleEvidence(ctx: TransportContext, params: {
    deviceId: string;
    snapshot: TransportDeviceSnapshot;
    capabilityId: BinaryControlObservation['capabilityId'];
    observedValue: boolean;
    // The transport seam the contradicting read came in on. A `pull`
    // (snapshot refresh) value with no timestamp may be Homey serving a
    // cached capability, so it must not erase a fresher pushed observation.
    // A `push` (device.update) is the device actively reporting its current
    // state, so it stays authoritative even without a timestamp.
    incomingSeam: 'pull' | 'push';
}): void {
    const {
        deviceId,
        snapshot,
        capabilityId,
        observedValue,
        incomingSeam,
    } = params;
    const existing = ctx.latestBinarySettleEvidenceByDeviceId.get(deviceId);
    if (!existing || existing.capabilityId !== capabilityId || existing.observedValue === observedValue) return;
    // A timestamp-less PULL read carries no evidence it is newer than a
    // pushed observation, so it must not erase a realtime/device_update
    // observation (lib/device/AGENTS.md "Never let an older full
    // fetch erase a fresher local or realtime observation without evidence
    // it is newer"). A genuine state change arrives via a push (realtime
    // listener / device.update), so the retained evidence stays supersedable
    // by any newer stamped read or push. The trusted observation wins and
    // currentOn reconciles to it. A timestamp-less PUSH is not held: it is
    // the device reporting its current state and stays authoritative.
    if (
        incomingSeam === 'pull'
        && (existing.source === 'realtime_capability' || existing.source === 'device_update')
    ) {
        applyBinarySettleEvidenceToSnapshot(ctx, snapshot, existing);
        return;
    }
    const snapshotObservation = snapshot.binaryControlObservation;
    clearBinarySettleEvidence(ctx, deviceId);
    if (
        incomingSeam === 'push'
        && snapshotObservation?.capabilityId === capabilityId
        && snapshotObservation.observedValue === observedValue
        && snapshotObservation.source === 'device_update'
    ) {
        snapshot.binaryControlObservation = snapshotObservation;
        return;
    }
    delete snapshot.binaryControlObservation;
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

export function reconcileBinarySettleEvidenceAfterSnapshotRefresh(
    ctx: TransportContext,
    snapshot: TransportDeviceSnapshot[],
    devices: HomeyDeviceLike[],
): void {
    const devicesById = new Map<string, HomeyDeviceLike>();
    for (const device of devices) {
        const deviceId = getDeviceId(device);
        if (deviceId) devicesById.set(deviceId, device);
    }

    for (const deviceSnapshot of snapshot) {
        const sourceDevice = devicesById.get(deviceSnapshot.id);
        if (!sourceDevice) continue;
        if (sourceDevice && hasInvalidBinaryControlPayload(deviceSnapshot, sourceDevice)) {
            clearBinarySettleEvidenceForInvalidControlPayload(ctx, {
                deviceId: deviceSnapshot.id,
                deviceName: deviceSnapshot.name,
                capabilityId: deviceSnapshot.binaryCapabilityId,
                source: 'snapshot_refresh',
                value: readCapabilityValue(
                    sourceDevice,
                    deviceSnapshot.binaryObservationCapabilityId ?? deviceSnapshot.binaryCapabilityId,
                ).value,
            });
            continue;
        }
        const payload = resolveBinaryControlPayload(sourceDevice, deviceSnapshot, deviceSnapshot);
        if (
            payload.present
            && payload.observedAtMs === undefined
            && typeof payload.value === 'boolean'
            && payload.capabilityId
        ) {
            clearContradictoryBinarySettleEvidence(ctx, {
                deviceId: deviceSnapshot.id,
                snapshot: deviceSnapshot,
                capabilityId: payload.capabilityId,
                observedValue: payload.value,
                incomingSeam: 'pull',
            });
        }
    }
}

export function applyBinarySettleEvidenceFromDeviceUpdate(ctx: TransportContext, params: {
    deviceId: string;
    device: HomeyDeviceLike;
    snapshot: TransportDeviceSnapshot | null;
    previousSnapshot: TransportDeviceSnapshot | undefined;
    skipInvalidControlPayload?: boolean;
}): void {
    const {
        deviceId,
        device,
        snapshot,
        previousSnapshot,
        skipInvalidControlPayload = false,
    } = params;
    if (!snapshot) {
        if (previousSnapshot) {
            const payload = resolveBinaryControlPayload(device, previousSnapshot, previousSnapshot);
            if (payload.present && typeof payload.value !== 'boolean') {
                clearBinarySettleEvidenceForInvalidControlPayload(ctx, {
                    deviceId,
                    deviceName: previousSnapshot.name,
                    capabilityId: payload.capabilityId,
                    source: 'device_update',
                    value: payload.value,
                });
                return;
            }
        }
        clearBinarySettleEvidence(ctx, deviceId);
        return;
    }
    if (skipInvalidControlPayload) return;
    const payload = resolveBinaryControlPayload(device, snapshot, previousSnapshot);
    if (!payload.present) {
        applyCachedBinarySettleEvidenceToSnapshot(ctx, snapshot);
        return;
    }
    if (typeof payload.value !== 'boolean') {
        clearBinarySettleEvidenceForInvalidControlPayload(ctx, {
            deviceId,
            deviceName: snapshot.name,
            capabilityId: payload.capabilityId,
            source: 'device_update',
            value: payload.value,
        });
        return;
    }
    if (!payload.capabilityId) return;
    if (isOlderEvCommandObservation(payload, previousSnapshot)) {
        applyCachedBinarySettleEvidenceToSnapshot(ctx, snapshot);
        return;
    }
    if (payload.observedAtMs === undefined) {
        clearContradictoryBinarySettleEvidence(ctx, {
            deviceId,
            snapshot,
            capabilityId: payload.capabilityId,
            observedValue: payload.value,
            incomingSeam: 'push',
        });
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

export function clearInvalidBinarySettleEvidenceFromDeviceUpdate(
    ctx: TransportContext,
    deviceId: string,
    device: HomeyDeviceLike,
    previousSnapshot: TransportDeviceSnapshot | undefined,
): { device: HomeyDeviceLike; hadInvalidBinaryControlPayload: boolean } {
    if (!previousSnapshot) return { device, hadInvalidBinaryControlPayload: false };
    const payload = resolveBinaryControlPayload(device, previousSnapshot, previousSnapshot);
    if (!payload.present || typeof payload.value === 'boolean') {
        return { device, hadInvalidBinaryControlPayload: false };
    }
    clearBinarySettleEvidenceForInvalidControlPayload(ctx, {
        deviceId,
        deviceName: previousSnapshot.name,
        capabilityId: payload.capabilityId,
        source: 'device_update',
        value: payload.value,
    });
    return { device, hadInvalidBinaryControlPayload: true };
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
