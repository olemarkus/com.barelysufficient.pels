import type { TargetDeviceSnapshot } from '../utils/types';
import {
    clearLocalCapabilityWrite,
    formatBinaryState,
    type RecentLocalCapabilityWrites,
} from './deviceManagerRealtimeSupport';
import { isRealtimeControlCapability } from './deviceManagerRuntime';
import type { PlanRealtimeUpdateEvent } from './deviceManagerRealtimeHandlers';

export const LOCAL_BINARY_SETTLE_WINDOW_MS = 5 * 1000;

type PendingBinarySettleWindow = {
    deviceId: string;
    capabilityId: string;
    name: string;
    desired: boolean;
    timer: ReturnType<typeof setTimeout>;
};

export type DeviceManagerBinarySettleState = {
    pendingBinarySettleWindows: Map<string, PendingBinarySettleWindow>;
};

type BinarySettleDeps = {
    logger: {
        structuredLog?: {
            info?: (payload: Record<string, unknown>) => void;
        };
    };
    recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
    isLiveFeedHealthy: () => boolean;
    shouldTrackRealtimeDevice: (deviceId: string) => boolean;
    getSnapshotById: (deviceId: string) => TargetDeviceSnapshot | undefined;
    emitPlanReconcile: (event: PlanRealtimeUpdateEvent) => void;
};

export function createBinarySettleState(): DeviceManagerBinarySettleState {
    return {
        pendingBinarySettleWindows: new Map(),
    };
}

export function hasPendingBinarySettleWindow(
    state: DeviceManagerBinarySettleState,
    deviceId: string,
    capabilityId: string,
): boolean {
    return state.pendingBinarySettleWindows.has(buildPendingBinarySettleKey(deviceId, capabilityId));
}

export function clearPendingBinarySettleWindow(
    state: DeviceManagerBinarySettleState,
    deviceId: string,
    capabilityId: string,
): void {
    const key = buildPendingBinarySettleKey(deviceId, capabilityId);
    const pending = state.pendingBinarySettleWindows.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingBinarySettleWindows.delete(key);
}

export function clearAllPendingBinarySettleWindows(state: DeviceManagerBinarySettleState): void {
    for (const pending of state.pendingBinarySettleWindows.values()) {
        clearTimeout(pending.timer);
    }
    state.pendingBinarySettleWindows.clear();
}

export function startPendingBinarySettleWindow(params: {
    state: DeviceManagerBinarySettleState;
    deps: BinarySettleDeps;
    deviceId: string;
    capabilityId: string;
    value: unknown;
    deviceName?: string;
}): void {
    const {
        state,
        deps,
        deviceId,
        capabilityId,
        value,
        deviceName,
    } = params;
    if (typeof value !== 'boolean') return;
    if (!isRealtimeControlCapability(capabilityId)) return;
    if (!deps.isLiveFeedHealthy()) return;

    clearPendingBinarySettleWindow(state, deviceId, capabilityId);
    const key = buildPendingBinarySettleKey(deviceId, capabilityId);
    const name = deviceName || deviceId;
    const timer = setTimeout(() => {
        finalizePendingBinarySettleWindow(state, key, deps);
    }, LOCAL_BINARY_SETTLE_WINDOW_MS);
    state.pendingBinarySettleWindows.set(key, {
        deviceId,
        capabilityId,
        name,
        desired: value,
        timer,
    });
    deps.logger.structuredLog?.info?.({
        event: 'binary_write_started',
        deviceId,
        deviceName: name,
        capabilityId,
        desired: value,
        settleWindowMs: LOCAL_BINARY_SETTLE_WINDOW_MS,
    });
}

export function notePendingBinarySettleObservation(params: {
    state: DeviceManagerBinarySettleState;
    deps: BinarySettleDeps;
    deviceId: string;
    capabilityId: string;
    value: boolean;
    source: 'realtime_capability' | 'device_update';
}): 'settled' | 'drift' | 'none' {
    const {
        state,
        deps,
        deviceId,
        capabilityId,
        value,
        source,
    } = params;
    const key = buildPendingBinarySettleKey(deviceId, capabilityId);
    const pending = state.pendingBinarySettleWindows.get(key);
    if (!pending) return 'none';

    clearTimeout(pending.timer);
    state.pendingBinarySettleWindows.delete(key);

    const outcome = value === pending.desired ? 'settled' : 'drift';
    deps.logger.structuredLog?.info?.({
        event: 'binary_write_observed',
        deviceId,
        deviceName: pending.name,
        capabilityId,
        desired: pending.desired,
        observed: value,
        source,
        outcome,
    });

    clearLocalCapabilityWrite({
        recentLocalCapabilityWrites: deps.recentLocalCapabilityWrites,
        deviceId,
        capabilityId,
    });

    if (outcome === 'drift') {
        deps.emitPlanReconcile({
            deviceId,
            name: pending.name,
            capabilityId,
            changes: [{
                capabilityId,
                previousValue: formatBinaryState(pending.desired),
                nextValue: formatBinaryState(value),
            }],
        });
    }

    return outcome;
}

function finalizePendingBinarySettleWindow(
    state: DeviceManagerBinarySettleState,
    key: string,
    deps: BinarySettleDeps,
): void {
    const pending = state.pendingBinarySettleWindows.get(key);
    if (!pending) return;
    state.pendingBinarySettleWindows.delete(key);
    clearLocalCapabilityWrite({
        recentLocalCapabilityWrites: deps.recentLocalCapabilityWrites,
        deviceId: pending.deviceId,
        capabilityId: pending.capabilityId,
    });
    if (!deps.shouldTrackRealtimeDevice(pending.deviceId)) return;

    const snapshot = deps.getSnapshotById(pending.deviceId);
    if (!snapshot) return;

    deps.logger.structuredLog?.info?.({
        event: 'binary_write_timeout',
        deviceId: pending.deviceId,
        deviceName: pending.name,
        capabilityId: pending.capabilityId,
        desired: pending.desired,
    });

    const observed = snapshot.currentOn;
    if (observed === pending.desired) return;

    const changes = typeof observed === 'boolean'
        ? [{
            capabilityId: pending.capabilityId,
            previousValue: formatBinaryState(pending.desired),
            nextValue: formatBinaryState(observed),
        }]
        : undefined;
    deps.emitPlanReconcile({
        deviceId: pending.deviceId,
        name: snapshot.name,
        capabilityId: pending.capabilityId,
        changes,
    });
}

function buildPendingBinarySettleKey(deviceId: string, capabilityId: string): string {
    return `${deviceId}:${capabilityId}`;
}
