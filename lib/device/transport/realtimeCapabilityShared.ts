/**
 * Low-level shared helpers for the realtime capability-update pipeline:
 * value normalization, capability classification, echo-suppression lookup, and
 * the windowed debug emission. Kept in their own module so the native
 * stepped-load handlers and the main capability handler can both depend on them
 * without a cyclic import.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { isStateOfChargeCapabilityId } from './stateOfCharge';
import { REALTIME_CAPABILITY_EVENT_WINDOW_MS } from './transportTypes';
import { getDebugEmitter, isDebugTopicEnabled } from '../../logging/logger';
import type { TransportObservationState } from './transportObservationState';
import { TARGET_TEMPERATURE_CAPABILITY_ID } from './temperatureObservation';

const emitDeviceDebug = getDebugEmitter('devices', 'devices');

export function normalizeRealtimeCapabilityEventValue(capabilityId: string, value: unknown): unknown {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (capabilityId === 'measure_power' || capabilityId === 'meter_power') return Math.round(value);
        if (capabilityId.includes('temperature')) return Math.round(value * 10) / 10;
        return Math.round(value * 100) / 100;
    }
    if (typeof value === 'string') return value.trim();
    return value;
}

export function isFreshnessOnlyCapability(capabilityId: string): boolean {
    return capabilityId === 'measure_power'
        || capabilityId === 'measure_temperature'
        || capabilityId === 'evcharger_charging_state'
        || isStateOfChargeCapabilityId(capabilityId);
}

function isReconcileCapability(snapshot: TransportDeviceSnapshot, capabilityId: string): boolean {
    return capabilityId === snapshot.binaryCapabilityId
        || snapshot.targets.some((t) => t.id === capabilityId);
}

function isTrackedCapability(snapshot: TransportDeviceSnapshot, capabilityId: string): boolean {
    return isReconcileCapability(snapshot, capabilityId)
        || isFreshnessOnlyCapability(capabilityId)
        || (
            capabilityId === TARGET_TEMPERATURE_CAPABILITY_ID
            && snapshot.capabilities?.includes(TARGET_TEMPERATURE_CAPABILITY_ID) === true
        );
}

export function resolveRealtimeCapabilityEvent(
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): { capabilityId: string; value: unknown } | null {
    if (isTrackedCapability(snapshot, capabilityId)) {
        return { capabilityId, value };
    }
    if (
        snapshot.binaryObservationCapabilityId
        && snapshot.binaryCapabilityId
        && capabilityId === snapshot.binaryObservationCapabilityId
    ) {
        return {
            capabilityId: snapshot.binaryCapabilityId,
            value,
        };
    }
    return null;
}

export function hasMatchingRecentLocalWrite(
    observationState: TransportObservationState,
    deviceId: string,
    capabilityId: string,
    normalizedValue: unknown,
): boolean {
    const recentWrite = observationState.getRecentLocalCapabilityWrite(deviceId, capabilityId);
    if (!recentWrite) return false;
    return Object.is(
        normalizeRealtimeCapabilityEventValue(capabilityId, recentWrite.value),
        normalizedValue,
    );
}

export function emitCapabilityEventReceived(
    observationState: TransportObservationState,
    deviceId: string,
    capabilityId: string,
    normalizedValue: unknown,
): void {
    if (!isDebugTopicEnabled('devices')) return;
    const key = JSON.stringify([deviceId, capabilityId, normalizedValue]);
    if (!observationState.shouldEmitRealtimeCapabilityEvent(key, Date.now(), REALTIME_CAPABILITY_EVENT_WINDOW_MS)) {
        return;
    }
    emitDeviceDebug({
        event: 'device_capability_event_received',
        source: 'web_api_subscription',
        deviceId,
        capabilityId,
        value: normalizedValue,
    });
}
