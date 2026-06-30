/**
 * Low-level shared helpers for the realtime capability-update pipeline:
 * value normalization, capability classification, echo-suppression lookup, and
 * the windowed debug emission. Kept in their own module so the native
 * stepped-load handlers and the main capability handler can both depend on them
 * without a cyclic import.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import { shouldEmitWindowed } from '../../logging/logDedupe';
import { getRecentLocalCapabilityWrite } from './managerRealtimeSupport';
import { isStateOfChargeCapabilityId } from './stateOfCharge';
import { REALTIME_CAPABILITY_EVENT_WINDOW_MS } from './transportTypes';
import type { TransportContext } from './transportContext';

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

function isReconcileCapability(snapshot: TargetDeviceSnapshot, capabilityId: string): boolean {
    return capabilityId === snapshot.controlCapabilityId
        || snapshot.targets.some((t) => t.id === capabilityId);
}

function isTrackedCapability(snapshot: TargetDeviceSnapshot, capabilityId: string): boolean {
    return isReconcileCapability(snapshot, capabilityId) || isFreshnessOnlyCapability(capabilityId);
}

export function resolveRealtimeCapabilityEvent(
    snapshot: TargetDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): { capabilityId: string; value: unknown } | null {
    if (isTrackedCapability(snapshot, capabilityId)) {
        return { capabilityId, value };
    }
    if (
        snapshot.controlObservationCapabilityId
        && snapshot.controlCapabilityId
        && capabilityId === snapshot.controlObservationCapabilityId
    ) {
        return {
            capabilityId: snapshot.controlCapabilityId,
            value,
        };
    }
    return null;
}

export function hasMatchingRecentLocalWrite(
    ctx: TransportContext,
    deviceId: string,
    capabilityId: string,
    normalizedValue: unknown,
): boolean {
    const recentWrite = getRecentLocalCapabilityWrite({
        recentLocalCapabilityWrites: ctx.recentLocalCapabilityWrites,
        deviceId,
        capabilityId,
    });
    if (!recentWrite) return false;
    return Object.is(
        normalizeRealtimeCapabilityEventValue(capabilityId, recentWrite.value),
        normalizedValue,
    );
}

export function emitCapabilityEventReceived(
    ctx: TransportContext,
    deviceId: string,
    capabilityId: string,
    normalizedValue: unknown,
): void {
    if (!ctx.debugStructured) return;
    const key = JSON.stringify([deviceId, capabilityId, normalizedValue]);
    if (!shouldEmitWindowed({
        state: ctx.recentRealtimeCapabilityEventLogByKey,
        key,
        now: Date.now(),
        windowMs: REALTIME_CAPABILITY_EVENT_WINDOW_MS,
    })) {
        return;
    }
    ctx.debugStructured({
        event: 'device_capability_event_received',
        source: 'web_api_subscription',
        deviceId,
        capabilityId,
        value: normalizedValue,
    });
}
