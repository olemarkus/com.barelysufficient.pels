import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { DeviceFetchSource } from './managerFetch';

export type CapabilityObservationSource = 'device_update' | 'realtime_capability' | 'local_write';

export type CapabilityObservation = {
    value: unknown;
    observedAt: number;
    source: CapabilityObservationSource;
};

export type DeviceDebugObservedSource = {
    observedAt: number;
    path: 'snapshot_refresh' | 'device_update' | 'realtime_capability' | 'local_write';
    snapshot: TransportDeviceSnapshot | null;
    fetchSource?: DeviceFetchSource;
    capabilityId?: string;
    value?: unknown;
    localEcho?: boolean;
    shouldReconcilePlan?: boolean;
    preservedLocalState?: boolean;
    changes?: Array<{
        capabilityId: string;
        previousValue: string;
        nextValue: string;
    }>;
};

export type DeviceDebugObservedSources = {
    snapshotRefresh?: DeviceDebugObservedSource;
    deviceUpdate?: DeviceDebugObservedSource;
    realtimeCapabilities: Record<string, DeviceDebugObservedSource>;
    localWrites: Record<string, DeviceDebugObservedSource>;
};

export type DeviceTransportObservationState = {
    debugObservedSourcesByDeviceId: Map<string, DeviceDebugObservedSources>;
    capabilityObservations: Map<string, CapabilityObservation>;
    latestLocalWriteMsByDeviceId: Map<string, number>;
};

export function createObservationState(): DeviceTransportObservationState {
    return {
        debugObservedSourcesByDeviceId: new Map(),
        capabilityObservations: new Map(),
        latestLocalWriteMsByDeviceId: new Map(),
    };
}

export function buildCapabilityObservationKey(deviceId: string, capabilityId: string): string {
    return `${deviceId}:${capabilityId}`;
}
