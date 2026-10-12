/** Reconciles pushed capability values into transport state and observer events. */
import { formatBinaryState, formatTargetValue } from './managerRealtimeSupport';
import { applyFreshnessOnlyCapabilityUpdate } from './managerFreshness';
import {
  didMeasurePowerBecomeSignificantlyPositive,
} from './managerRealtimeHandlers';
import { normalizeNativeEvCapabilityUpdate } from '../nativeEvWiring';
import { MIN_SIGNIFICANT_POWER_W } from './transportTypes';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import {
  dispatchRealtimeDrift,
  dispatchRealtimeObservation,
  emitCapabilityEventReceived,
  hasMatchingRecentLocalWrite,
  isFreshnessOnlyCapability,
  normalizeRealtimeCapabilityEventValue,
  recordRealtimeObservation,
  resolveRealtimeCapabilityEvent,
} from './realtimeCapabilityShared';
import {
  handleNativeSteppedLoadCapabilityUpdate,
  handleTargetPowerSourceCapabilityUpdate,
} from './nativeSteppedRealtime';
import type { RealtimeIngestService } from './transportServices';
import {
  hasControlFacetBesideTemperature,
  removeTemperatureObservation,
  TARGET_TEMPERATURE_CAPABILITY_ID,
  updateTemperatureTarget,
} from './temperatureObservation';
import { handleThermostatModeCapabilityUpdate } from './thermostatModeRealtime';
import {
    handleHomeBatteryClaimCapabilityUpdate,
    handleHomeBatteryLevelCapabilityUpdate,
} from './homeBatteryObservation';
import type { ObservedControlStateChangedEvent, ObservedStateChangedEvent } from '../../ports/observedStateEvents';

const resolveBinaryAxisOn = (snapshot: TransportDeviceSnapshot, capabilityId: string, fallback: boolean): boolean => (
    capabilityId === 'evcharger_charging' ? (snapshot.evCharging ?? fallback) : (snapshot.binaryControl?.on ?? fallback)
);

/* eslint-disable functional/immutable-data -- Event changes are accumulated per accepted realtime update. */
function applyBinaryCapabilityUpdate(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: boolean,
    changes: NonNullable<ObservedControlStateChangedEvent['changes']>,
): void {
    const previousCurrentOn = snapshot.binaryControl?.on;
    const previousBinaryAxisOn = resolveBinaryAxisOn(
        snapshot,
        capabilityId,
        previousCurrentOn ?? true,
    );
    ingest.binaryEvidence.applyBinaryObservationToSnapshot(snapshot, capabilityId, value, 'realtime_capability');
    // Resolve both sides through the may-draw default before comparing so an
    // absent (non-binary) previous state can't read as a spurious on<->on change.
    const previousOn = previousBinaryAxisOn;
    const nextOn = resolveBinaryAxisOn(snapshot, capabilityId, true);
    // NOT dispatched when the fold is unchanged, though
    // `applyBinaryObservationToSnapshot` may have re-stamped
    // `binaryControlObservation` — see the `TODO.md` entry on transport writes
    // that never reach the projection. The one-line dispatch that belongs here by
    // analogy with `measure_power` cuts across binary-settle semantics: a report
    // equal to the PRE-write value while PELS's own command is in flight is
    // deliberately kept quiet ("keeps equal realtime control truth quiet after an
    // accepted write", `test/integration/deviceManager.test.ts`), and separating
    // "re-stamped an observation" from "echoed a command we have not settled"
    // needs the settle path's own analysis, not a fold comparison.
    if (nextOn === previousOn) return;
    changes.push({
        capabilityId,
        ...(capabilityId === 'evcharger_charging' ? { observedCapabilityId: capabilityId } : {}),
        previousValue: formatBinaryState(previousOn),
        nextValue: formatBinaryState(nextOn),
    });
}
/* eslint-enable functional/immutable-data */

function handleFreshnessOnlyCapabilityUpdate(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): void {
    const deviceId = snapshot.id;
    const previousPowerKw = capabilityId === 'measure_power'
        ? snapshot.measuredPowerKw
        : undefined;
    const result = applyFreshnessOnlyCapabilityUpdate(snapshot, capabilityId, value);
    if (handleTemperatureFreshnessOutcome(ingest, snapshot, capabilityId, result)) return;
    const reconcileChange = result.reconcileChange;
    if (!result.changed) {
        // ONLY for a reading that was accepted and advanced a stamp. A rejected
        // one mutated nothing, and dispatching it would bump the projection's
        // accepted-write revision for an observation that never happened.
        // Accepted repeated reports still advance freshness; push that stamp even
        // when the value is unchanged, or the observer stays stale until the next
        // refresh. This is also required by `resolveConfirmedNotDrawing`'s
        // 60-second window. See the parallel step-report path in
        // `nativeSteppedRealtime.ts`.
        if (result.observationAdvanced) dispatchRealtimeObservation(ingest, deviceId, capabilityId);
        return;
    }
    recordRealtimeObservation(ingest, deviceId, capabilityId, result.normalizedValue, true);
    if (capabilityId === 'measure_power') {
        ingest.notifications.snapshotChanged(snapshot, Date.now());
    }
    const cursor = ingest.observationBridge.nextCursor(deviceId);
    ingest.observationBridge.dispatchStateChanged({
        source: 'realtime_capability',
        deviceId,
        ...cursor,
        capabilityId,
        measurePowerBecameSignificantlyPositive: capabilityId === 'measure_power'
            && didMeasurePowerBecomeSignificantlyPositive(
                previousPowerKw,
                snapshot.measuredPowerKw,
                MIN_SIGNIFICANT_POWER_W,
            ),
    });
    if (reconcileChange) {
        dispatchRealtimeDrift(ingest, snapshot, cursor, reconcileChange.capabilityId, [reconcileChange]);
    }
}

function handleTemperatureFreshnessOutcome(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    result: ReturnType<typeof applyFreshnessOnlyCapabilityUpdate>,
): boolean {
    if (!result.temperatureRecoveryRequested && !result.temperatureFacetRemoved) return false;
    recordRealtimeObservation(ingest, snapshot.id, capabilityId, result.normalizedValue, false);
    if (result.temperatureRecoveryRequested) {
        ingest.temperatureRecovery.request(snapshot.id);
        return true;
    }
    dropTemperatureFacet(ingest, snapshot, capabilityId);
    return true;
}

/**
 * The device lost its setpoint: drop it entirely when no other control facet
 * remains, then publish the removal.
 */
function dropTemperatureFacet(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
): void {
    if (!hasControlFacetBesideTemperature(snapshot)) ingest.reader.snapshotStore.removeSnapshotEntry(snapshot.id);
    const cursor = dispatchRealtimeObservation(ingest, snapshot.id, capabilityId);
    dispatchRealtimeDrift(ingest, snapshot, cursor, TARGET_TEMPERATURE_CAPABILITY_ID, [{
        capabilityId: TARGET_TEMPERATURE_CAPABILITY_ID,
        previousValue: 'present',
        nextValue: 'absent',
    }]);
}

// Event changes and the held target update belong to this accepted report.
/* eslint-disable functional/immutable-data */
function handleTemperatureCapabilityUpdate(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    value: unknown,
    changes: NonNullable<ObservedControlStateChangedEvent['changes']>,
): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        recordRealtimeObservation(ingest, snapshot.id, TARGET_TEMPERATURE_CAPABILITY_ID, value, false);
        if (!removeTemperatureObservation(snapshot)) return true;
        dropTemperatureFacet(ingest, snapshot, TARGET_TEMPERATURE_CAPABILITY_ID);
        return true;
    }
    if (!snapshot.temperature) {
        recordRealtimeObservation(ingest, snapshot.id, TARGET_TEMPERATURE_CAPABILITY_ID, value, false);
        ingest.temperatureRecovery.request(snapshot.id);
        return true;
    }
    const result = updateTemperatureTarget(snapshot, value);
    if (!result.changed || result.previousValue === undefined) return true;
    changes.push({
        capabilityId: TARGET_TEMPERATURE_CAPABILITY_ID,
        previousValue: formatTargetValue(result.previousValue, snapshot.temperature.target.unit),
        nextValue: formatTargetValue(value, snapshot.temperature.target.unit),
    });
    return false;
}
/* eslint-enable functional/immutable-data */

function handleBinaryCapabilityEvent(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
    changes: NonNullable<ObservedControlStateChangedEvent['changes']>,
): boolean {
    if (capabilityId !== snapshot.binaryCapabilityId) return false;
    if (typeof value === 'boolean') {
        // Not handled here: the shared tail of `handleReconcileCapabilityUpdate`
        // publishes the change this collected.
        applyBinaryCapabilityUpdate(ingest, snapshot, capabilityId, value, changes);
        return false;
    }
    if (capabilityId !== 'onoff' && capabilityId !== 'evcharger_charging') return false;
    ingest.binaryEvidence.clearInvalidControlPayload(snapshot.id, capabilityId);
    return true;
}

/* eslint-disable functional/immutable-data -- Realtime writes update the transport-owned snapshot before dispatch. */
function handleReconcileCapabilityUpdate(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): void {
    const deviceId = snapshot.id;
    const changes: ObservedControlStateChangedEvent['changes'] = [];

    if (
        capabilityId === TARGET_TEMPERATURE_CAPABILITY_ID
        && handleTemperatureCapabilityUpdate(ingest, snapshot, value, changes)
    ) return;

    if (handleBinaryCapabilityEvent(ingest, snapshot, capabilityId, value, changes)) return;

    for (const target of snapshot.targets) {
        if (target.id === TARGET_TEMPERATURE_CAPABILITY_ID) continue;
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
        ingest.observationBridge.state,
        deviceId,
        capabilityId,
        normalizeRealtimeCapabilityEventValue(capabilityId, value),
    );
    ingest.binaryEvidence.recordRealtimeCapabilityObservation(deviceId, [capabilityId]);
    const cursor = dispatchRealtimeObservation(ingest, deviceId, capabilityId);
    dispatchRealtimeDrift(ingest, snapshot, cursor, capabilityId, changes);
}
/* eslint-enable functional/immutable-data */

export function handleRealtimeCapabilityUpdate(
    ingest: RealtimeIngestService,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): void {
    if (!ingest.reader.shouldTrackRealtimeDevice(deviceId)) return;
    const snapshot = ingest.reader.snapshotStore.getSnapshot().find((entry) => entry.id === deviceId);
    if (snapshot === undefined) {
        recoverMissingTemperatureSnapshot(ingest, deviceId, capabilityId, value);
        return;
    }
    if (handleObservedOnlyCapabilityUpdate(ingest, snapshot, capabilityId, value)) return;

    const normalizedEvents = normalizeNativeEvCapabilityUpdate({
        snapshot,
        capabilityId,
        value,
    });
    for (const normalizedEvent of normalizedEvents) {
        if (handleNativeSteppedLoadCapabilityUpdate(
            ingest, snapshot, normalizedEvent.capabilityId, normalizedEvent.value,
        )) continue;
        if (handleTargetPowerSourceCapabilityUpdate(
            ingest, snapshot, normalizedEvent.capabilityId, normalizedEvent.value,
        )) continue;

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
            && hasMatchingRecentLocalWrite(
                ingest.observationBridge.state,
                deviceId,
                effectiveCapabilityId,
                normalizedValue,
            )
        ) {
            continue;
        }

        if (isFreshnessOnlyCapability(effectiveCapabilityId)) {
            handleFreshnessOnlyCapabilityUpdate(ingest, snapshot, effectiveCapabilityId, effectiveValue);
            continue;
        }

        handleReconcileCapabilityUpdate(ingest, snapshot, effectiveCapabilityId, effectiveValue);
    }
}

/**
 * Capabilities that are neither an EV nor a stepped-load capability, and not a
 * target PELS writes: a thermostat mode, and a home battery's claim and level.
 * True when the event was one of them.
 */
function handleObservedOnlyCapabilityUpdate(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): boolean {
    const nextCursor = (id: string) => ingest.observationBridge.nextCursor(id);
    const dispatchStateChanged = (event: ObservedStateChangedEvent) => (
        ingest.observationBridge.dispatchStateChanged(event)
    );
    return handleThermostatModeCapabilityUpdate(
        nextCursor,
        dispatchStateChanged,
        (event) => ingest.observationBridge.dispatchControlStateChanged(event),
        snapshot, capabilityId, value,
    ) || handleHomeBatteryClaimCapabilityUpdate(nextCursor, dispatchStateChanged, snapshot, capabilityId, value)
        || handleHomeBatteryLevelCapabilityUpdate(nextCursor, dispatchStateChanged, snapshot, capabilityId, value);
}

function recoverMissingTemperatureSnapshot(
    ingest: RealtimeIngestService,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): void {
    const isTemperatureCapability = capabilityId === 'measure_temperature'
        || capabilityId === TARGET_TEMPERATURE_CAPABILITY_ID;
    if (!isTemperatureCapability || typeof value !== 'number' || !Number.isFinite(value)) return;
    recordRealtimeObservation(ingest, deviceId, capabilityId, value, false);
    ingest.temperatureRecovery.request(deviceId);
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
    ingest: RealtimeIngestService,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): void {
    handleRealtimeCapabilityUpdate(ingest, deviceId, capabilityId, value);
    ingest.observationProducers.evCarLink.noteCapabilityUpdate(deviceId, capabilityId, value, Date.now());
}
