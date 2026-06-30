/**
 * Binary-settle evidence bookkeeping for `DeviceTransport`, extracted as
 * homey-free free functions over a shared `TransportContext`. Governs the
 * planned/commanded/observed separation + source-trust ordering described in
 * `lib/device/AGENTS.md`: an older full fetch must never roll back a fresher
 * realtime or local-write observation. Functions mutate the SAME evidence map
 * and snapshot objects the leaf owns (passed by reference through the context).
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { BinaryControlObservation, TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceId } from './managerHelpers';
import {
  resolveEvChargingStateBinaryEvidence,
  resolveEvCurrentOn,
  toCapabilityTimestampMs,
} from '../managerControl';
import { recordSnapshotCapabilityObservations } from './managerObservation';
import type { ObservedDeviceStateEvent } from './managerRealtimeHandlers';
import { getLogger } from '../../logging/logger';
import { cloneBinaryControlObservation, isRawBinarySettlementEvidenceAllowed } from './transportTypes';
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
    snapshot: TargetDeviceSnapshot,
    previousSnapshot: TargetDeviceSnapshot | undefined,
): {
    present: boolean;
    capabilityId: TargetDeviceSnapshot['controlCapabilityId'];
    observedCapabilityId: string;
    value: unknown;
    observedAtMs?: number;
} {
    const capabilityId = snapshot.controlCapabilityId ?? previousSnapshot?.controlCapabilityId;
    const observedCapabilityId = (
        snapshot.controlObservationCapabilityId
        ?? previousSnapshot?.controlObservationCapabilityId
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

export function hasInvalidBinaryControlPayload(snapshot: TargetDeviceSnapshot, device: HomeyDeviceLike): boolean {
    if (!snapshot.controlCapabilityId) return false;
    const observedCapabilityId = snapshot.controlObservationCapabilityId ?? snapshot.controlCapabilityId;
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
    capabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
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
    const acceptedEvidence = upsertBinarySettleEvidence(ctx, snapshot.id, evidence);
    const mutableSnapshot = snapshot;
    if (acceptedEvidence.capabilityId === 'evcharger_charging') {
        mutableSnapshot.evCharging = acceptedEvidence.observedValue;
        mutableSnapshot.binaryControl = {
            on: resolveEvCurrentOn({
                evChargingState: mutableSnapshot.evChargingState,
                evchargerCharging: acceptedEvidence.observedValue,
            }),
        };
    } else {
        mutableSnapshot.binaryControl = { on: acceptedEvidence.observedValue };
    }
    mutableSnapshot.binaryControlObservation = acceptedEvidence;
    return acceptedEvidence;
}

export function persistBinarySettleEvidenceToSnapshot(
    ctx: TransportContext,
    snapshot: TargetDeviceSnapshot,
    evidence: BinaryControlObservation,
): BinaryControlObservation {
    const acceptedEvidence = upsertBinarySettleEvidence(ctx, snapshot.id, evidence);
    const mutableSnapshot = snapshot;
    mutableSnapshot.binaryControlObservation = acceptedEvidence;
    return acceptedEvidence;
}

export function applyCachedBinarySettleEvidenceToSnapshot(ctx: TransportContext, snapshot: TargetDeviceSnapshot): void {
    const cached = ctx.latestBinarySettleEvidenceByDeviceId.get(snapshot.id);
    if (!cached) return;
    if (cached.capabilityId !== snapshot.controlCapabilityId) return;
    applyBinarySettleEvidenceToSnapshot(ctx, snapshot, cached);
}

export function clearContradictoryBinarySettleEvidence(ctx: TransportContext, params: {
    deviceId: string;
    snapshot: TargetDeviceSnapshot;
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
    snapshot: TargetDeviceSnapshot,
): boolean {
    return !ctx.shouldTrackRealtimeDevice(snapshot.id) || snapshot.managed === false;
}

export function reconcileBinarySettleEvidenceWithSnapshot(
    ctx: TransportContext,
    snapshot: TargetDeviceSnapshot[],
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

export function shouldClearRawEvBinaryEvidenceForStatePayload(
    ctx: TransportContext,
    snapshot: TargetDeviceSnapshot,
    sourceDevice: HomeyDeviceLike,
): boolean {
    if (snapshot.controlCapabilityId !== 'evcharger_charging') return false;
    if (!readCapabilityValue(sourceDevice, 'evcharger_charging_state').present) return false;
    const evidence = snapshot.binaryControlObservation
        ?? ctx.latestBinarySettleEvidenceByDeviceId.get(snapshot.id);
    if (!evidence || evidence.capabilityId !== 'evcharger_charging') return false;
    return !evidence.observedCapabilityIds.includes('evcharger_charging_state');
}

export function reconcileBinarySettleEvidenceAfterSnapshotRefresh(
    ctx: TransportContext,
    snapshot: TargetDeviceSnapshot[],
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
                capabilityId: deviceSnapshot.controlCapabilityId,
                source: 'snapshot_refresh',
                value: readCapabilityValue(
                    sourceDevice,
                    deviceSnapshot.controlObservationCapabilityId ?? deviceSnapshot.controlCapabilityId,
                ).value,
            });
            continue;
        }
        if (shouldClearRawEvBinaryEvidenceForStatePayload(ctx, deviceSnapshot, sourceDevice)) {
            clearBinarySettleEvidence(ctx, deviceSnapshot.id);
            delete deviceSnapshot.binaryControlObservation;
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

export function applyEvStateSettleEvidenceFromDeviceUpdate(ctx: TransportContext, params: {
    deviceId: string;
    device: HomeyDeviceLike;
    snapshot: TargetDeviceSnapshot;
}): boolean {
    const {
        deviceId,
        device,
        snapshot,
    } = params;
    if (snapshot.controlCapabilityId !== 'evcharger_charging') return false;
    const statePayload = readCapabilityValue(device, 'evcharger_charging_state');
    if (!statePayload.present) return false;
    const observedValue = resolveEvChargingStateBinaryEvidence(statePayload.value);
    if (observedValue === undefined || statePayload.observedAtMs === undefined) {
        clearBinarySettleEvidence(ctx, deviceId);
        delete snapshot.binaryControlObservation;
        return true;
    }
    const evidence: BinaryControlObservation = {
        valid: true,
        capabilityId: 'evcharger_charging',
        observedValue,
        observedCapabilityIds: ['evcharger_charging_state'],
        observedAtMs: statePayload.observedAtMs,
        source: 'device_update',
    };
    persistBinarySettleEvidenceToSnapshot(ctx, snapshot, evidence);
    return true;
}

export function applyBinarySettleEvidenceFromDeviceUpdate(ctx: TransportContext, params: {
    deviceId: string;
    device: HomeyDeviceLike;
    snapshot: TargetDeviceSnapshot | null;
    previousSnapshot: TargetDeviceSnapshot | undefined;
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
    const evStateHandled = applyEvStateSettleEvidenceFromDeviceUpdate(ctx, {
        deviceId,
        device,
        snapshot,
    });
    if (evStateHandled) return;
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

export function clearInvalidBinarySettleEvidenceFromDeviceUpdate(
    ctx: TransportContext,
    deviceId: string,
    device: HomeyDeviceLike,
    previousSnapshot: TargetDeviceSnapshot | undefined,
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
        mutableSnapshot.binaryControl = {
            on: resolveEvCurrentOn({
                evChargingState: mutableSnapshot.evChargingState,
                evchargerCharging: value,
            }),
        };
        if (!isRawBinarySettlementEvidenceAllowed(mutableSnapshot, capabilityId)) return;
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

export function handleFreshnessBinaryObservation(ctx: TransportContext, params: {
    snapshot: TargetDeviceSnapshot;
    deviceId: string;
    eventCapabilityId: string;
    binaryControlObservation?: BinaryControlObservation;
}): boolean {
    const {
        snapshot,
        deviceId,
        eventCapabilityId,
        binaryControlObservation,
    } = params;
    const acceptedObservation = binaryControlObservation
        ? persistBinarySettleEvidenceToSnapshot(ctx, snapshot, binaryControlObservation)
        : undefined;
    if (!acceptedObservation) {
        if (eventCapabilityId === 'evcharger_charging_state') {
            clearBinarySettleEvidence(ctx, deviceId);
            delete snapshot.binaryControlObservation;
        }
        return false;
    }
    let settleCursor: SettleCursor | undefined;
    const ensureSettleCursor = (): SettleCursor => {
        settleCursor ??= ctx.nextObservationCursor(deviceId);
        return settleCursor;
    };
    const settleOutcome = ctx.binarySettleOps.note({
        state: ctx.binarySettleState,
        deps: ctx.getBinarySettleDeps(),
        deviceId,
        capabilityId: acceptedObservation.capabilityId,
        value: acceptedObservation.observedValue,
        source: 'realtime_capability',
        ensureEventFields: ensureSettleCursor,
    });
    if (settleOutcome === 'none') return false;
    recordRealtimeCapabilityObservation(ctx, {
        deviceId,
        eventCapabilityId,
        observedCapabilityIds: acceptedObservation.observedCapabilityIds,
    }, false, ensureSettleCursor());
    return true;
}
