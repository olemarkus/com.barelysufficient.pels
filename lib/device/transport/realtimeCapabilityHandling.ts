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
import { recordCapabilityObservation } from './managerObservation';
import { formatBinaryState, formatTargetValue } from './managerRealtimeSupport';
import { applyFreshnessOnlyCapabilityUpdate } from './managerFreshness';
import {
  didMeasurePowerBecomeSignificantlyPositive,
  type ObservedDeviceStateEvent,
  type PlanRealtimeUpdateEvent,
} from './managerRealtimeHandlers';
import { normalizeNativeEvCapabilityUpdate } from '../nativeEvWiring';
import { MIN_SIGNIFICANT_POWER_W } from './transportTypes';
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

const resolveBinaryAxisOn = (
    snapshot: TargetDeviceSnapshot,
    capabilityId: string,
    fallback: boolean,
): boolean => (
    capabilityId === 'evcharger_charging'
        ? (snapshot.evCharging ?? fallback)
        : (snapshot.binaryControl?.on ?? fallback)
);

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
    const previousBinaryAxisOn = resolveBinaryAxisOn(
        snapshot,
        capabilityId,
        previousCurrentOn ?? true,
    );
    // Check the settle window before the equality check so a confirmation
    // observation (value === currentOn) can still settle it.
    //
    // The raw echo settles the window for EVERY control capability, chargers
    // included. The window's question is "was PELS's write acknowledged?", and
    // the raw axis is the axis PELS wrote, so it is the answer: measured at p50
    // 7.3 s and never later than 9.2 s, on all 115 charger writes in the
    // 2026-08-11→13 production log. Settlement used to be gated on
    // `isRawBinaryObservedTruthEvidenceAllowed`, which excludes chargers because
    // their observed on/off truth is plug-state-authoritative — a different
    // question. That gate left the window waiting on `evcharger_charging_state`,
    // i.e. "is the car drawing?", which arrived at p50 29.7 s and never at all
    // when the car was full or had stopped by itself (8 of 58 starts). So every
    // charger write ran to timeout and reported drift against a snapshot older
    // than the write, on a command the charger had accepted. Whether the car
    // then draws is the EV resume probe's question, with its own deadline and
    // back-off ladder; this window must not answer it too.
    //
    // Observed on/off truth is unaffected: `applyBinaryObservationToSnapshot`
    // still resolves a charger's `binaryControl.on` through `resolveEvCurrentOn`,
    // where the plug-state stays authoritative.
    const hasSettleWindow = ctx.binarySettleOps.hasWindow(ctx.binarySettleState, deviceId, capabilityId);
    if (hasSettleWindow) {
        applyBinaryObservationToSnapshot(ctx, snapshot, capabilityId, value, 'realtime_capability');
    }
    let settleCursor: ObservedCursorFields | undefined;
    const ensureSettleCursor = (): ObservedCursorFields => {
        settleCursor ??= ctx.nextObservationCursor(deviceId);
        return settleCursor;
    };
    const settleOutcome = ctx.binarySettleOps.note({
        state: ctx.binarySettleState,
        deps: ctx.getBinarySettleDeps(),
        deviceId,
        capabilityId,
        value,
        source: 'realtime_capability',
        ensureEventFields: ensureSettleCursor,
    });
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
