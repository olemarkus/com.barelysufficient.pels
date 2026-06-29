import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HandleRealtimeDeviceUpdateResult } from './managerRealtimeHandlers';
import type { DeviceFetchSource } from './managerFetch';
import type {
    DeviceDebugObservedSource,
    DeviceDebugObservedSources,
    DeviceTransportObservationState,
} from './observationState';

export function getDebugObservedSources(
    state: DeviceTransportObservationState,
    deviceId: string,
): DeviceDebugObservedSources | null {
    const sources = state.debugObservedSourcesByDeviceId.get(deviceId);
    if (!sources) return null;
    return {
        ...(sources.snapshotRefresh ? { snapshotRefresh: cloneObservedSource(sources.snapshotRefresh) } : {}),
        ...(sources.deviceUpdate ? { deviceUpdate: cloneObservedSource(sources.deviceUpdate) } : {}),
        realtimeCapabilities: Object.fromEntries(
            Object.entries(sources.realtimeCapabilities).map(([capabilityId, source]) => [
                capabilityId,
                cloneObservedSource(source),
            ]),
        ),
        localWrites: Object.fromEntries(
            Object.entries(sources.localWrites).map(([capabilityId, source]) => [
                capabilityId,
                cloneObservedSource(source),
            ]),
        ),
    };
}

export function recordSnapshotRefreshObservations(params: {
    state: DeviceTransportObservationState;
    snapshot: TransportDeviceSnapshot[];
    fetchSource: DeviceFetchSource;
}): void {
    const {
        state,
        snapshot,
        fetchSource,
    } = params;
    const observedAt = Date.now();
    const activeDeviceIds = new Set(snapshot.map((device) => device.id));
    for (const deviceId of state.debugObservedSourcesByDeviceId.keys()) {
        if (!activeDeviceIds.has(deviceId)) {
            state.debugObservedSourcesByDeviceId.delete(deviceId);
        }
    }
    for (const device of snapshot) {
        const sources = getOrCreateDebugObservedSources(state, device.id);
        sources.snapshotRefresh = {
            observedAt,
            path: 'snapshot_refresh',
            snapshot: cloneTransportDeviceSnapshotForDebug(device),
            fetchSource,
        };
    }
}

export function recordDeviceUpdateObservation(params: {
    state: DeviceTransportObservationState;
    latestSnapshot: TransportDeviceSnapshot[];
    deviceId: string;
    result: HandleRealtimeDeviceUpdateResult;
}): void {
    const {
        state,
        latestSnapshot,
        deviceId,
        result,
    } = params;
    const sources = getOrCreateDebugObservedSources(state, deviceId);
    sources.deviceUpdate = {
        observedAt: Date.now(),
        path: 'device_update',
        snapshot: buildCurrentDebugSnapshot(latestSnapshot, deviceId),
        shouldReconcilePlan: result.shouldReconcilePlan,
        ...(result.changes.length > 0 ? { changes: result.changes.map((change) => ({ ...change })) } : {}),
    };
}

export function cloneTransportDeviceSnapshotForDebug(
    snapshot: TransportDeviceSnapshot | null,
): TransportDeviceSnapshot | null {
    if (!snapshot) return null;
    return {
        ...snapshot,
        targets: snapshot.targets.map((target) => ({ ...target })),
        capabilities: Array.isArray(snapshot.capabilities) ? [...snapshot.capabilities] : snapshot.capabilities,
    };
}

function cloneObservedSource(source: DeviceDebugObservedSource): DeviceDebugObservedSource {
    return {
        ...source,
        snapshot: cloneTransportDeviceSnapshotForDebug(source.snapshot),
        changes: source.changes?.map((change) => ({ ...change })),
    };
}

function createEmptyObservedSources(): DeviceDebugObservedSources {
    return {
        realtimeCapabilities: {},
        localWrites: {},
    };
}

export function getOrCreateDebugObservedSources(
    state: DeviceTransportObservationState,
    deviceId: string,
): DeviceDebugObservedSources {
    let sources = state.debugObservedSourcesByDeviceId.get(deviceId);
    if (!sources) {
        sources = createEmptyObservedSources();
        state.debugObservedSourcesByDeviceId.set(deviceId, sources);
    }
    return sources;
}

export function buildCurrentDebugSnapshot(
    latestSnapshot: TransportDeviceSnapshot[],
    deviceId: string,
): TransportDeviceSnapshot | null {
    const snapshot = latestSnapshot.find((entry) => entry.id === deviceId) ?? null;
    return cloneTransportDeviceSnapshotForDebug(snapshot);
}
