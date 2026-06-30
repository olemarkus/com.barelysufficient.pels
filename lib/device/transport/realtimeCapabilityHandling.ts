/**
 * Realtime per-capability update handling for `DeviceTransport`, extracted as
 * homey-free free functions over a shared `TransportContext`. Translates an
 * incoming Web-API capability event into snapshot mutations + observed-state /
 * plan-reconcile dispatches, honouring echo-suppression, binary-settle windows,
 * native stepped-load drift, and freshness-only capabilities. Low-level helpers
 * live in `realtimeCapabilityShared`; native stepped-load handling in
 * `nativeSteppedRealtime`.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import { getLogger } from '../../logging/logger';
import { resolveEvCurrentOn } from '../managerControl';
import { recordCapabilityObservation } from './managerObservation';
import { formatBinaryState, formatTargetValue } from './managerRealtimeSupport';
import { applyFreshnessOnlyCapabilityUpdate } from './managerFreshness';
import {
  didMeasurePowerBecomeSignificantlyPositive,
  type ObservedDeviceStateEvent,
  type PlanRealtimeUpdateEvent,
} from './managerRealtimeHandlers';
import { normalizeNativeEvCapabilityUpdate } from '../nativeEvWiring';
import { MIN_SIGNIFICANT_POWER_W, isRawBinarySettlementEvidenceAllowed } from './transportTypes';
import {
  applyBinaryObservationToSnapshot,
  clearBinarySettleEvidenceForInvalidControlPayload,
  handleFreshnessBinaryObservation,
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

type ObservedCursorFields = Pick<ObservedDeviceStateEvent, 'observationSeq' | 'observedAtMs'>;

/** Returns true if the change was handled by the binary settle window. */
function applyBinaryCapabilityUpdate(ctx: TransportContext, params: {
    snapshotIndex: number;
    deviceId: string;
    capabilityId: string;
    value: boolean;
    changes: NonNullable<PlanRealtimeUpdateEvent['changes']>;
}): boolean {
    const {
        snapshotIndex,
        deviceId,
        capabilityId,
        value,
        changes,
    } = params;
    const snapshot = ctx.latestSnapshot[snapshotIndex];
    const previousCurrentOn = snapshot.binaryControl?.on;
    // Check the settle window before the equality check so a confirmation
    // observation (value === currentOn) can still settle it.
    const hasSettleWindow = ctx.binarySettleOps.hasWindow(ctx.binarySettleState, deviceId, capabilityId);
    const isSettlementEvidence = isRawBinarySettlementEvidenceAllowed(snapshot, capabilityId);
    if (hasSettleWindow && isSettlementEvidence) {
        applyBinaryObservationToSnapshot(ctx, snapshot, capabilityId, value, 'realtime_capability');
    }
    if (hasSettleWindow && !isSettlementEvidence) {
        if (capabilityId === 'evcharger_charging') {
            snapshot.binaryControl = {
                on: resolveEvCurrentOn({
                    evChargingState: snapshot.evChargingState,
                    evchargerCharging: snapshot.evCharging,
                }),
            };
        }
        recordRealtimeCapabilityObservation(ctx, {
            deviceId,
            eventCapabilityId: capabilityId,
            observedCapabilityIds: [capabilityId],
        });
        return true;
    }
    let settleCursor: ObservedCursorFields | undefined;
    const ensureSettleCursor = (): ObservedCursorFields => {
        settleCursor ??= ctx.nextObservationCursor(deviceId);
        return settleCursor;
    };
    const settleOutcome = isSettlementEvidence
        ? ctx.binarySettleOps.note({
            state: ctx.binarySettleState,
            deps: ctx.getBinarySettleDeps(),
            deviceId,
            capabilityId,
            value,
            source: 'realtime_capability',
            ensureEventFields: ensureSettleCursor,
        })
        : 'none';
    if (settleOutcome !== 'none') {
        // Record the observation so freshness tracking advances even for settle events.
        recordRealtimeCapabilityObservation(ctx, {
            deviceId,
            eventCapabilityId: capabilityId,
            observedCapabilityIds: [capabilityId],
        }, false, ensureSettleCursor());
        return true; // reconcile already emitted by settle window on drift; none needed on settle
    }

    if (!hasSettleWindow) {
        applyBinaryObservationToSnapshot(ctx, snapshot, capabilityId, value, 'realtime_capability');
    }
    // Resolve both sides through the may-draw default before comparing so an
    // absent (non-binary) previous state can't read as a spurious on<->on change.
    const previousOn = previousCurrentOn ?? true;
    const nextOn = snapshot.binaryControl?.on ?? true;
    if (nextOn === previousOn) return false;
    changes.push({
        capabilityId,
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
    if (handleFreshnessBinaryObservation(ctx, {
        snapshot,
        deviceId,
        eventCapabilityId: capabilityId,
        binaryControlObservation: result.binaryControlObservation,
    })) return;
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
    snapshot: TargetDeviceSnapshot;
}): void {
    const {
        snapshotIndex,
        deviceId,
        capabilityId,
        value,
        snapshot,
    } = params;
    const changes: PlanRealtimeUpdateEvent['changes'] = [];

    if (capabilityId === snapshot.controlCapabilityId && typeof value === 'boolean') {
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
        capabilityId === snapshot.controlCapabilityId
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
        // Skip echo suppression when a binary settle window is active so the
        // confirmation observation can close it immediately.
        const hasBinarySettleWindow = effectiveCapabilityId === snapshot.controlCapabilityId
            && ctx.consultPendingPredicate(deviceId, effectiveCapabilityId);
        if (
            !hasBinarySettleWindow
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
