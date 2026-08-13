/**
 * Realtime per-capability update handling for `DeviceTransport`, extracted as
 * homey-free free functions over a shared `TransportContext`. Translates an
 * incoming Web-API capability event into snapshot mutations + observed-state /
 * plan-reconcile dispatches, honouring target/step echo suppression, pending
 * binary-command confirmation, native stepped-load drift, and freshness-only capabilities. Low-level helpers
 * live in `realtimeCapabilityShared`; native stepped-load handling in
 * `nativeSteppedRealtime`.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import { getLogger } from '../../logging/logger';
import { recordCapabilityObservation } from './managerObservation';
import { formatBinaryState, formatTargetValue } from './managerRealtimeSupport';
import { applyFreshnessOnlyCapabilityUpdate } from './managerFreshness';
import {
  didMeasurePowerBecomeSignificantlyPositive,
  type PlanRealtimeUpdateEvent,
} from './managerRealtimeHandlers';
import { normalizeNativeEvCapabilityUpdate } from '../nativeEvWiring';
import { MIN_SIGNIFICANT_POWER_W } from './transportTypes';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import {
  applyBinaryObservationToSnapshot,
  clearBinarySettleEvidenceForInvalidControlPayload,
  recordRealtimeCapabilityObservation,
} from './binarySettleEvidence';
import {
  emitCapabilityEventReceived,
  hasMatchingRecentLocalWrite,
  isFreshnessOnlyCapability,
  normalizeRealtimeCapabilityEventValue,
  resolveRealtimeCapabilityEvent,
} from './realtimeCapabilityShared';
import {
  handleNativeSteppedLoadCapabilityUpdate,
  handleTargetPowerSourceCapabilityUpdate,
} from './nativeSteppedRealtime';
import type { TransportContext } from './transportContext';

const moduleLogger = getLogger('device/transport');

const resolveBinaryAxisOn = (
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    fallback: boolean,
): boolean => (
    capabilityId === 'evcharger_charging'
        ? (snapshot.evCharging ?? fallback)
        : (snapshot.binaryControl?.on ?? fallback)
);

function applyBinaryCapabilityUpdate(ctx: TransportContext, params: {
    snapshotIndex: number;
    deviceId: string;
    capabilityId: string;
    value: boolean;
    changes: NonNullable<PlanRealtimeUpdateEvent['changes']>;
}): boolean {
    const {
        snapshotIndex,
        deviceId: _deviceId,
        capabilityId,
        value,
        changes,
    } = params;
    const snapshot = ctx.latestSnapshot[snapshotIndex];
    const previousCurrentOn = snapshot.binaryControl?.on;
    const previousBinaryAxisOn = resolveBinaryAxisOn(
        snapshot,
        capabilityId,
        previousCurrentOn ?? true,
    );
    applyBinaryObservationToSnapshot(ctx, snapshot, capabilityId, value, 'realtime_capability');
    // Resolve both sides through the may-draw default before comparing so an
    // absent (non-binary) previous state can't read as a spurious on<->on change.
    const previousOn = previousBinaryAxisOn;
    const nextOn = resolveBinaryAxisOn(snapshot, capabilityId, true);
    if (nextOn === previousOn) return false;
    changes.push({
        capabilityId,
        ...(capabilityId === 'evcharger_charging' ? { observedCapabilityId: capabilityId } : {}),
        previousValue: formatBinaryState(previousOn),
        nextValue: formatBinaryState(nextOn),
    });
    return false;
}

function handleFreshnessOnlyCapabilityUpdate(
    ctx: TransportContext,
    snapshotIndex: number,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): void {
    const snapshot = ctx.latestSnapshot[snapshotIndex];
    const previousPowerKw = capabilityId === 'measure_power'
        ? snapshot?.measuredPowerKw
        : undefined;
    const result = applyFreshnessOnlyCapabilityUpdate({
        snapshot,
        capabilityId,
        value,
    });
    const reconcileChange = result.reconcileChange;
    if (!result.changed) return;
    recordCapabilityObservation({
        state: ctx.observationState,
        latestSnapshot: ctx.latestSnapshot,
        deviceId,
        capabilityId,
        value: result.normalizedValue,
        source: 'realtime_capability',
    });
    if (capabilityId === 'measure_power' && snapshot) {
        ctx.onSnapshotMutated?.(snapshot, Date.now());
    }
    const cursor = ctx.nextObservationCursor(deviceId);
    ctx.dispatchObservedStateChanged({
        source: 'realtime_capability',
        deviceId,
        ...cursor,
        capabilityId,
        measurePowerBecameSignificantlyPositive: capabilityId === 'measure_power'
            && didMeasurePowerBecomeSignificantlyPositive(
                previousPowerKw,
                snapshot?.measuredPowerKw,
                MIN_SIGNIFICANT_POWER_W,
            ),
    });
    if (reconcileChange && snapshot) {
        (ctx.logger.structuredLog ?? moduleLogger).info({
            event: 'realtime_capability_drift',
            deviceId,
            capabilityId: reconcileChange.capabilityId,
            changes: [reconcileChange],
        });
        ctx.dispatchPlanReconcile({
            deviceId,
            ...cursor,
            name: snapshot.name,
            changes: [reconcileChange],
        });
    }
}

function handleReconcileCapabilityUpdate(ctx: TransportContext, params: {
    snapshotIndex: number;
    deviceId: string;
    capabilityId: string;
    value: unknown;
    snapshot: TransportDeviceSnapshot;
}): void {
    const {
        snapshotIndex,
        deviceId,
        capabilityId,
        value,
        snapshot,
    } = params;
    const changes: PlanRealtimeUpdateEvent['changes'] = [];

    if (capabilityId === snapshot.binaryCapabilityId && typeof value === 'boolean') {
        const settled = applyBinaryCapabilityUpdate(ctx, { snapshotIndex, deviceId, capabilityId, value, changes });
        if (settled) {
            emitCapabilityEventReceived(
                ctx,
                deviceId,
                capabilityId,
                normalizeRealtimeCapabilityEventValue(capabilityId, value),
            );
            return;
        }
    }
    if (
        capabilityId === snapshot.binaryCapabilityId
        && (capabilityId === 'onoff' || capabilityId === 'evcharger_charging')
        && typeof value !== 'boolean'
    ) {
        clearBinarySettleEvidenceForInvalidControlPayload(ctx, {
            deviceId,
            deviceName: snapshot.name,
            capabilityId,
            source: 'realtime_capability',
            value,
        });
        return;
    }

    for (const target of snapshot.targets) {
        if (
            target.id === capabilityId
            && typeof value === 'number'
            && Number.isFinite(value)
            && target.value !== value
        ) {
            const previousValue = target.value;
            target.value = value;
            changes.push({
                capabilityId,
                previousValue: formatTargetValue(previousValue, target.unit),
                nextValue: formatTargetValue(value, target.unit),
            });
            break;
        }
    }

    if (changes.length === 0) return;

    emitCapabilityEventReceived(
        ctx,
        deviceId,
        capabilityId,
        normalizeRealtimeCapabilityEventValue(capabilityId, value),
    );
    (ctx.logger.structuredLog ?? moduleLogger).info({
        event: 'realtime_capability_drift',
        deviceId,
        capabilityId,
        changes,
    });
    recordRealtimeCapabilityObservation(ctx, {
        deviceId,
        eventCapabilityId: capabilityId,
        observedCapabilityIds: [capabilityId],
    }, changes.length > 0);
    const cursor = ctx.nextObservationCursor(deviceId);
    ctx.dispatchObservedStateChanged({
        source: 'realtime_capability',
        deviceId,
        ...cursor,
        capabilityId,
    });
    ctx.dispatchPlanReconcile({
        deviceId,
        ...cursor,
        name: snapshot.name,
        changes,
    });
}

export function handleRealtimeCapabilityUpdate(
    ctx: TransportContext,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): void {
    if (!ctx.shouldTrackRealtimeDevice(deviceId)) return;
    const snapshotIndex = ctx.latestSnapshot.findIndex((entry) => entry.id === deviceId);
    if (snapshotIndex < 0) return;

    const snapshot = ctx.latestSnapshot[snapshotIndex];
    const normalizedEvents = normalizeNativeEvCapabilityUpdate({
        snapshot,
        capabilityId,
        value,
    });
    for (const normalizedEvent of normalizedEvents) {
        const handledNativeSteppedLoadUpdate = handleNativeSteppedLoadCapabilityUpdate(ctx, {
            snapshotIndex,
            deviceId,
            capabilityId: normalizedEvent.capabilityId,
            value: normalizedEvent.value,
            snapshot,
        });
        if (handledNativeSteppedLoadUpdate) continue;
        const handledTargetPowerSourceUpdate = handleTargetPowerSourceCapabilityUpdate(ctx, {
            snapshotIndex,
            deviceId,
            capabilityId: normalizedEvent.capabilityId,
            value: normalizedEvent.value,
            snapshot,
        });
        if (handledTargetPowerSourceUpdate) continue;

        const resolvedEvent = resolveRealtimeCapabilityEvent(
            snapshot,
            normalizedEvent.capabilityId,
            normalizedEvent.value,
        );
        if (!resolvedEvent) continue;
        const effectiveCapabilityId = resolvedEvent.capabilityId;
        const effectiveValue = resolvedEvent.value;

        const normalizedValue = normalizeRealtimeCapabilityEventValue(
            effectiveCapabilityId,
            effectiveValue,
        );
        // A binary write is never observed optimistically. Its matching echo is
        // therefore real observed truth and must pass through even when no
        // pending consumer is currently attached. Target/step writes retain
        // their duplicate-event suppression.
        const isBinaryObservation = effectiveCapabilityId === snapshot.binaryCapabilityId;
        if (
            !isBinaryObservation
            && hasMatchingRecentLocalWrite(ctx, deviceId, effectiveCapabilityId, normalizedValue)
        ) {
            continue;
        }

        if (isFreshnessOnlyCapability(effectiveCapabilityId)) {
            handleFreshnessOnlyCapabilityUpdate(
                ctx,
                snapshotIndex,
                deviceId,
                effectiveCapabilityId,
                effectiveValue,
            );
            continue;
        }

        handleReconcileCapabilityUpdate(ctx, {
            snapshotIndex,
            deviceId,
            capabilityId: effectiveCapabilityId,
            value: effectiveValue,
            snapshot,
        });
    }
}

/**
 * The capability-event entry point the SDK leaf calls: apply the value, THEN let
 * the EV car-link probe observe.
 *
 * The order is the point, so it lives with the handler rather than in the leaf.
 * `handleRealtimeCapabilityUpdate` returns early for anything outside the managed
 * snapshot, which is every class `car` device — so the probe would never hear a
 * car at all if it were called from inside. And running it before the value is
 * applied would correlate a charger event against the charger's PREVIOUS state.
 */
export function handleRealtimeCapabilityUpdateWithProbe(
    ctx: TransportContext,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): void {
    handleRealtimeCapabilityUpdate(ctx, deviceId, capabilityId, value);
    ctx.observationProducers.evCarLink.noteCapabilityUpdate(deviceId, capabilityId, value, Date.now());
}
