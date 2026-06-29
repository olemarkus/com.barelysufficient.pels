import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import {
    EV_SOC_NATIVE_CAPABILITY_IDS,
    isStateOfChargeCapabilityId,
} from './stateOfCharge';
import {
    buildCapabilityObservationKey,
    type CapabilityObservationSource,
    type DeviceTransportObservationState,
} from './observationState';
import { buildCurrentDebugSnapshot, getOrCreateDebugObservedSources } from './observationDebugSources';

type RecordSnapshotObservationOptions = {
    state: DeviceTransportObservationState;
    deviceId: string;
    snapshot: TransportDeviceSnapshot;
    source: CapabilityObservationSource;
    observedAt: number;
    capabilityIdSet: Set<string> | null;
};

export function recordLocalWriteObservation(params: {
    state: DeviceTransportObservationState;
    latestSnapshot: TransportDeviceSnapshot[];
    deviceId: string;
    capabilityId: string;
    value: unknown;
    preservedLocalState: boolean;
}): void {
    const {
        state,
        latestSnapshot,
        deviceId,
        capabilityId,
        value,
        preservedLocalState,
    } = params;
    const observedAt = Date.now();
    const sources = getOrCreateDebugObservedSources(state, deviceId);
    sources.localWrites[capabilityId] = {
        observedAt,
        path: 'local_write',
        snapshot: buildCurrentDebugSnapshot(latestSnapshot, deviceId),
        capabilityId,
        value,
        preservedLocalState,
    };
    recordCapabilityObservation({
        state,
        latestSnapshot,
        deviceId,
        capabilityId,
        value,
        source: 'local_write',
        observedAt,
    });
}

export function recordSnapshotCapabilityObservations(params: {
    state: DeviceTransportObservationState;
    latestSnapshot: TransportDeviceSnapshot[];
    deviceId: string;
    source: CapabilityObservationSource;
    capabilityIds?: string[];
}): void {
    const {
        state,
        latestSnapshot,
        deviceId,
        source,
        capabilityIds,
    } = params;
    const snapshot = latestSnapshot.find((entry) => entry.id === deviceId);
    if (!snapshot) return;
    const observedAt = Date.now();
    const capabilityIdSet = capabilityIds ? new Set(capabilityIds) : null;
    const recordedFreshData = [
        recordSnapshotControlObservation({ state, deviceId, snapshot, source, observedAt, capabilityIdSet }),
        recordSnapshotTargetObservations({ state, deviceId, snapshot, source, observedAt, capabilityIdSet }),
        recordSnapshotScalarObservation(state, snapshot, {
            deviceId,
            capabilityId: 'measure_power',
            value: snapshot.measuredPowerKw,
            source,
            observedAt,
            capabilityIdSet,
        }),
        recordSnapshotScalarObservation(state, snapshot, {
            deviceId,
            capabilityId: 'evcharger_charging_state',
            value: snapshot.evChargingState,
            source,
            observedAt,
            capabilityIdSet,
        }),
    ].some(Boolean);
    const stateOfChargeCapabilityId = snapshot.stateOfCharge?.capabilityId;
    const observedStateOfChargeCapabilityId = stateOfChargeCapabilityId
        && isStateOfChargeCapabilityId(stateOfChargeCapabilityId)
        ? stateOfChargeCapabilityId
        : 'measure_battery';
    recordSnapshotScalarObservation(state, snapshot, {
        deviceId,
        capabilityId: observedStateOfChargeCapabilityId,
        value: snapshot.stateOfCharge?.percent,
        source,
        observedAt,
        capabilityIdSet,
        countsTowardDeviceFreshness: false,
    });
    if (recordedFreshData) {
        snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observedAt);
        snapshot.lastUpdated = snapshot.lastFreshDataMs;
    }
}

export function recordCapabilityObservation(params: {
    state: DeviceTransportObservationState;
    latestSnapshot: TransportDeviceSnapshot[];
    deviceId: string;
    capabilityId: string;
    value: unknown;
    source: CapabilityObservationSource;
    observedAt?: number;
    snapshot?: TransportDeviceSnapshot;
    countsTowardDeviceFreshness?: boolean;
}): void {
    const {
        state,
        latestSnapshot,
        deviceId,
        capabilityId,
        value,
        source,
        observedAt = Date.now(),
        snapshot,
        countsTowardDeviceFreshness = !isStateOfChargeCapabilityId(capabilityId),
    } = params;
    state.capabilityObservations.set(buildCapabilityObservationKey(deviceId, capabilityId), {
        value,
        observedAt,
        source,
    });
    const resolvedSnapshot = snapshot ?? latestSnapshot.find((entry) => entry.id === deviceId);
    if (!resolvedSnapshot) return;
    if (source === 'local_write') {
        updateLocalWriteTimestamps(state, latestSnapshot, deviceId, observedAt, resolvedSnapshot);
        return;
    }
    if (!countsTowardDeviceFreshness) return;
    resolvedSnapshot.lastFreshDataMs = Math.max(resolvedSnapshot.lastFreshDataMs ?? 0, observedAt);
    resolvedSnapshot.lastUpdated = resolvedSnapshot.lastFreshDataMs;
}

export function resolveLatestLocalWriteMs(
    state: DeviceTransportObservationState,
    deviceId: string,
): number | undefined {
    return state.latestLocalWriteMsByDeviceId.get(deviceId);
}

function recordSnapshotControlObservation(options: RecordSnapshotObservationOptions): boolean {
    const {
        state,
        deviceId,
        snapshot,
        source,
        observedAt,
        capabilityIdSet,
    } = options;
    if (
        !snapshot.controlCapabilityId
        || (capabilityIdSet && !capabilityIdSet.has(snapshot.controlCapabilityId))
    ) {
        return false;
    }
    const controlValue = snapshot.controlCapabilityId === 'evcharger_charging'
        ? snapshot.evCharging
        : snapshot.binaryControl?.on;
    if (typeof controlValue !== 'boolean') {
        return false;
    }
    recordCapabilityObservation({
        state,
        latestSnapshot: [],
        deviceId,
        capabilityId: snapshot.controlCapabilityId,
        value: controlValue,
        source,
        observedAt,
        snapshot,
    });
    return true;
}

function recordSnapshotTargetObservations(options: RecordSnapshotObservationOptions): boolean {
    const {
        state,
        deviceId,
        snapshot,
        source,
        observedAt,
        capabilityIdSet,
    } = options;
    let recorded = false;
    for (const target of snapshot.targets) {
        if (capabilityIdSet && !capabilityIdSet.has(target.id)) continue;
        recordCapabilityObservation({
            state,
            latestSnapshot: [],
            deviceId,
            capabilityId: target.id,
            value: target.value,
            source,
            observedAt,
            snapshot,
        });
        recorded = true;
    }
    return recorded;
}

function recordSnapshotScalarObservation(
    state: DeviceTransportObservationState,
    snapshot: TransportDeviceSnapshot,
    params: {
        deviceId: string;
        capabilityId: 'measure_power' | 'evcharger_charging_state' | (typeof EV_SOC_NATIVE_CAPABILITY_IDS)[number];
        value: number | string | undefined;
        source: CapabilityObservationSource;
        observedAt: number;
        capabilityIdSet: Set<string> | null;
        countsTowardDeviceFreshness?: boolean;
    },
): boolean {
    const {
        deviceId,
        capabilityId,
        value,
        source,
        observedAt,
        capabilityIdSet,
        countsTowardDeviceFreshness = true,
    } = params;
    if (typeof value !== 'number' && typeof value !== 'string') return false;
    if (capabilityIdSet && !capabilityIdSet.has(capabilityId)) return false;
    recordCapabilityObservation({
        state,
        latestSnapshot: [],
        deviceId,
        capabilityId,
        value,
        source,
        observedAt,
        snapshot,
        countsTowardDeviceFreshness,
    });
    return true;
}

function updateLocalWriteTimestamps(
    state: DeviceTransportObservationState,
    latestSnapshot: TransportDeviceSnapshot[],
    deviceId: string,
    observedAt: number,
    snapshot?: TransportDeviceSnapshot,
): void {
    const resolvedSnapshot = snapshot ?? latestSnapshot.find((entry) => entry.id === deviceId);
    if (resolvedSnapshot) {
        resolvedSnapshot.lastLocalWriteMs = (
            Math.max(resolvedSnapshot.lastLocalWriteMs ?? 0, observedAt) || undefined
        );
    }
    state.latestLocalWriteMsByDeviceId.set(
        deviceId,
        Math.max(state.latestLocalWriteMsByDeviceId.get(deviceId) ?? 0, observedAt),
    );
}
