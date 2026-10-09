/** Reconciles pushed capability values into transport state and observer events. */
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
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
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

const moduleLogger = getLogger('device/transport');

const resolveBinaryAxisOn = (snapshot: TransportDeviceSnapshot, capabilityId: string, fallback: boolean): boolean => (
    capabilityId === 'evcharger_charging' ? (snapshot.evCharging ?? fallback) : (snapshot.binaryControl?.on ?? fallback)
);

/* eslint-disable functional/immutable-data -- Event changes are accumulated per accepted realtime update. */
function applyBinaryCapabilityUpdate(ingest: RealtimeIngestService, params: {
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
    const snapshot = ingest.reader.snapshotStore.getSnapshot()[snapshotIndex];
    // The caller resolved this index against the same snapshot array; there is no
    // binary axis to update without it.
    if (snapshot === undefined) return false;
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
    if (nextOn === previousOn) return false;
    changes.push({
        capabilityId,
        ...(capabilityId === 'evcharger_charging' ? { observedCapabilityId: capabilityId } : {}),
        previousValue: formatBinaryState(previousOn),
        nextValue: formatBinaryState(nextOn),
    });
    return false;
}
/* eslint-enable functional/immutable-data */

/** Accepted repeated reports still advance freshness; push that stamp even when
 * the value is unchanged, or the observer stays stale until the next refresh.
 * This is also required by `resolveConfirmedNotDrawing`'s 60-second window.
 * Rejected payloads remain a no-op. See the parallel step-report path in
 * `nativeSteppedRealtime.ts`.
 */
const dispatchFreshnessOnlyObservation = (
    ingest: RealtimeIngestService,
    deviceId: string,
    capabilityId: string,
): void => ingest.observationBridge.dispatchStateChanged({
    source: 'realtime_capability',
    deviceId,
    ...ingest.observationBridge.nextCursor(deviceId),
    capabilityId,
});

function handleFreshnessOnlyCapabilityUpdate(
    ingest: RealtimeIngestService,
    snapshotIndex: number,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): void {
    const snapshot = ingest.reader.snapshotStore.getSnapshot()[snapshotIndex];
    // The caller resolved this index against the same snapshot array; without an entry
    // there is nothing to bump freshness on.
    if (snapshot === undefined) return;
    const previousPowerKw = capabilityId === 'measure_power'
        ? snapshot.measuredPowerKw
        : undefined;
    const result = applyFreshnessOnlyCapabilityUpdate({
        snapshot,
        capabilityId,
        value,
    });
    if (handleTemperatureFreshnessOutcome(ingest, {
        snapshotIndex,
        deviceId,
        capabilityId,
        snapshot,
        result,
    })) return;
    const reconcileChange = result.reconcileChange;
    if (!result.changed) {
        // ONLY for a reading that was accepted and advanced a stamp. A rejected
        // one mutated nothing, and dispatching it would bump the projection's
        // accepted-write revision for an observation that never happened.
        if (result.observationAdvanced) dispatchFreshnessOnlyObservation(ingest, deviceId, capabilityId);
        return;
    }
    recordCapabilityObservation({
        state: ingest.observationBridge.state.getObservationState(),
        latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
        deviceId,
        capabilityId,
        value: result.normalizedValue,
        source: 'realtime_capability',
        countsTowardDeviceFreshness: true,
    });
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
        moduleLogger.info({
            event: 'realtime_capability_drift',
            deviceId,
            capabilityId: reconcileChange.capabilityId,
            changes: [reconcileChange],
        });
        ingest.observationBridge.dispatchControlStateChanged({
            deviceId,
            ...cursor,
            name: snapshot.name,
            changes: [reconcileChange],
        });
    }
}

function handleTemperatureFreshnessOutcome(
    ingest: RealtimeIngestService,
    params: {
        snapshotIndex: number;
        deviceId: string;
        capabilityId: string;
        snapshot: TransportDeviceSnapshot;
        result: ReturnType<typeof applyFreshnessOnlyCapabilityUpdate>;
    },
): boolean {
    const {
        snapshotIndex, deviceId, capabilityId, snapshot, result,
    } = params;
    if (!result.temperatureRecoveryRequested && !result.temperatureFacetRemoved) return false;
    recordCapabilityObservation({
        state: ingest.observationBridge.state.getObservationState(),
        latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
        deviceId,
        capabilityId,
        value: result.normalizedValue,
        source: 'realtime_capability',
        countsTowardDeviceFreshness: false,
    });
    if (result.temperatureRecoveryRequested) {
        ingest.temperatureRecovery.request(deviceId);
        return true;
    }
    dropDeviceWithoutRemainingControlFacet(ingest, snapshotIndex, snapshot);
    const cursor = ingest.observationBridge.nextCursor(deviceId);
    ingest.observationBridge.dispatchStateChanged({
        source: 'realtime_capability',
        deviceId,
        ...cursor,
        capabilityId,
    });
    dispatchTemperatureFacetRemoval(ingest, deviceId, snapshot, cursor);
    return true;
}

function dispatchTemperatureFacetRemoval(
    ingest: RealtimeIngestService,
    deviceId: string,
    snapshot: TransportDeviceSnapshot,
    cursor: ReturnType<RealtimeIngestService['observationBridge']['nextCursor']>,
): void {
    const changes = [{
        capabilityId: TARGET_TEMPERATURE_CAPABILITY_ID,
        previousValue: 'present',
        nextValue: 'absent',
    }];
    moduleLogger.info({
        event: 'realtime_capability_drift',
        deviceId,
        capabilityId: TARGET_TEMPERATURE_CAPABILITY_ID,
        changes,
    });
    ingest.observationBridge.dispatchControlStateChanged({ deviceId, ...cursor, name: snapshot.name, changes });
}

function dropDeviceWithoutRemainingControlFacet(
    ingest: RealtimeIngestService,
    snapshotIndex: number,
    snapshot: TransportDeviceSnapshot,
): void {
    if (hasControlFacetBesideTemperature(snapshot)) return;
    ingest.reader.snapshotStore.removeSnapshotAt(snapshotIndex, snapshot.id);
}
// Event changes and the held target update belong to this accepted report.
/* eslint-disable functional/immutable-data */
function handleTemperatureCapabilityUpdate(ingest: RealtimeIngestService, params: {
    snapshotIndex: number;
    deviceId: string;
    value: unknown;
    snapshot: TransportDeviceSnapshot;
    changes: NonNullable<PlanRealtimeUpdateEvent['changes']>;
}): boolean {
    const {
        snapshotIndex, deviceId, value, snapshot, changes,
    } = params;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        recordCapabilityObservation({
            state: ingest.observationBridge.state.getObservationState(),
            latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
            deviceId,
            capabilityId: TARGET_TEMPERATURE_CAPABILITY_ID,
            value,
            source: 'realtime_capability',
            countsTowardDeviceFreshness: false,
        });
        if (!removeTemperatureObservation(snapshot)) return true;
        dropDeviceWithoutRemainingControlFacet(ingest, snapshotIndex, snapshot);
        const cursor = ingest.observationBridge.nextCursor(deviceId);
        ingest.observationBridge.dispatchStateChanged({
            source: 'realtime_capability',
            deviceId,
            ...cursor,
            capabilityId: TARGET_TEMPERATURE_CAPABILITY_ID,
        });
        dispatchTemperatureFacetRemoval(ingest, deviceId, snapshot, cursor);
        return true;
    }
    if (!snapshot.temperature) {
        recordCapabilityObservation({
            state: ingest.observationBridge.state.getObservationState(),
            latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
            deviceId,
            capabilityId: TARGET_TEMPERATURE_CAPABILITY_ID,
            value,
            source: 'realtime_capability',
            countsTowardDeviceFreshness: false,
        });
        ingest.temperatureRecovery.request(deviceId);
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

function handleBinaryCapabilityEvent(ingest: RealtimeIngestService, params: {
    snapshotIndex: number;
    deviceId: string;
    capabilityId: string;
    value: unknown;
    snapshot: TransportDeviceSnapshot;
    changes: NonNullable<PlanRealtimeUpdateEvent['changes']>;
}): boolean {
    const {
        snapshotIndex, deviceId, capabilityId, value, snapshot, changes,
    } = params;
    if (capabilityId !== snapshot.binaryCapabilityId) return false;
    if (typeof value === 'boolean') {
        const settled = applyBinaryCapabilityUpdate(ingest, {
            snapshotIndex, deviceId, capabilityId, value, changes,
        });
        if (settled) {
            emitCapabilityEventReceived(
                ingest.observationBridge.state,
                deviceId,
                capabilityId,
                normalizeRealtimeCapabilityEventValue(capabilityId, value),
            );
        }
        return settled;
    }
    if (capabilityId !== 'onoff' && capabilityId !== 'evcharger_charging') return false;
    ingest.binaryEvidence.clearInvalidControlPayload(deviceId, capabilityId);
    return true;
}

/* eslint-disable functional/immutable-data -- Realtime writes update the transport-owned snapshot before dispatch. */
function handleReconcileCapabilityUpdate(ingest: RealtimeIngestService, params: {
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

    if (
        capabilityId === TARGET_TEMPERATURE_CAPABILITY_ID
        && handleTemperatureCapabilityUpdate(ingest, {
            snapshotIndex, deviceId, value, snapshot, changes,
        })
    ) return;

    if (handleBinaryCapabilityEvent(ingest, {
        snapshotIndex, deviceId, capabilityId, value, snapshot, changes,
    })) return;

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
    moduleLogger.info({
        event: 'realtime_capability_drift',
        deviceId,
        capabilityId,
        changes,
    });
    ingest.binaryEvidence.recordRealtimeCapabilityObservation(deviceId, [capabilityId]);
    const cursor = ingest.observationBridge.nextCursor(deviceId);
    ingest.observationBridge.dispatchStateChanged({
        source: 'realtime_capability',
        deviceId,
        ...cursor,
        capabilityId,
    });
    ingest.observationBridge.dispatchControlStateChanged({
        deviceId,
        ...cursor,
        name: snapshot.name,
        changes,
    });
}
/* eslint-enable functional/immutable-data */

export function handleRealtimeCapabilityUpdate(
    ingest: RealtimeIngestService,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): void {
    if (!ingest.reader.shouldTrackRealtimeDevice(deviceId)) return;
    const snapshotIndex = ingest.reader.snapshotStore.getSnapshot().findIndex((entry) => entry.id === deviceId);
    const snapshot = ingest.reader.snapshotStore.getSnapshot()[snapshotIndex];
    // `findIndex` misses read back as an absent entry, so one check covers both.
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
        const handledNativeSteppedLoadUpdate = handleNativeSteppedLoadCapabilityUpdate(ingest, {
            snapshotIndex,
            deviceId,
            capabilityId: normalizedEvent.capabilityId,
            value: normalizedEvent.value,
            snapshot,
        });
        if (handledNativeSteppedLoadUpdate) continue;
        const handledTargetPowerSourceUpdate = handleTargetPowerSourceCapabilityUpdate(ingest, {
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
            handleFreshnessOnlyCapabilityUpdate(
                ingest,
                snapshotIndex,
                deviceId,
                effectiveCapabilityId,
                effectiveValue,
            );
            continue;
        }

        handleReconcileCapabilityUpdate(ingest, {
            snapshotIndex,
            deviceId,
            capabilityId: effectiveCapabilityId,
            value: effectiveValue,
            snapshot,
        });
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
    const dispatchStateChanged = (event: ObservedDeviceStateEvent) => (
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
    recordCapabilityObservation({
        state: ingest.observationBridge.state.getObservationState(),
        latestSnapshot: ingest.reader.snapshotStore.getSnapshot(),
        deviceId,
        capabilityId,
        value,
        source: 'realtime_capability',
        countsTowardDeviceFreshness: false,
    });
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
