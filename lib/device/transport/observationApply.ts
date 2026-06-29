import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import {
    isEvChargingState,
    resolveEvChargingStateBinaryEvidence,
    resolveEvCurrentOn,
} from '../managerControl';
import {
    isStateOfChargeCapabilityId,
    updateStateOfChargeFromRealtimeCapability,
    updateStateOfChargeSessionBoundary,
} from './stateOfCharge';
import {
    buildCapabilityObservationKey,
    type CapabilityObservation,
    type DeviceTransportObservationState,
} from './observationState';

export function applyCapabilityObservation(
    nextSnapshot: TransportDeviceSnapshot,
    capabilityId: string,
    observation: CapabilityObservation,
): boolean {
    if (capabilityId === nextSnapshot.controlCapabilityId) {
        return applyControlCapabilityObservation(nextSnapshot, observation);
    }
    if (capabilityId === 'evcharger_charging_state') {
        return applyEvChargingStateObservation(nextSnapshot, observation);
    }
    if (capabilityId === 'measure_power') {
        return applyMeasuredPowerObservation(nextSnapshot, observation);
    }
    if (capabilityId === 'measure_temperature') {
        return applyMeasuredTemperatureObservation(nextSnapshot, observation);
    }
    if (isStateOfChargeCapabilityId(capabilityId)) {
        return applyStateOfChargeObservation(nextSnapshot, capabilityId, observation);
    }
    return applyTargetCapabilityObservation(nextSnapshot, capabilityId, observation);
}

function applyControlCapabilityObservation(
    nextSnapshot: TransportDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    if (typeof observation.value !== 'boolean') return false;
    const previousCurrentOn = snapshot.binaryControl?.on;
    const previousEvCharging = snapshot.evCharging;
    if (snapshot.controlCapabilityId === 'evcharger_charging') {
        snapshot.evCharging = observation.value;
        snapshot.binaryControl = {
            on: resolveEvCurrentOn({
                evChargingState: snapshot.evChargingState,
                evchargerCharging: snapshot.evCharging,
            }),
        };
    } else {
        snapshot.binaryControl = { on: observation.value };
    }
    if (
        previousCurrentOn === snapshot.binaryControl?.on
        && snapshot.controlCapabilityId !== 'evcharger_charging'
    ) {
        return false;
    }
    if (
        previousCurrentOn === snapshot.binaryControl?.on
        && snapshot.controlCapabilityId === 'evcharger_charging'
        && previousEvCharging === snapshot.evCharging
    ) {
        return false;
    }
    if (observation.source === 'local_write') {
        snapshot.lastLocalWriteMs = Math.max(snapshot.lastLocalWriteMs ?? 0, observation.observedAt);
        return true;
    }
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs ?? snapshot.lastUpdated;
    return true;
}

function applyEvChargingStateObservation(
    nextSnapshot: TransportDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    if (typeof observation.value !== 'string') return false;
    // An out-of-enum value is a real transition out of a known state, so
    // normalise it to `undefined` and apply it — never strand the stale (and
    // possibly commandable) prior state. A non-string value (above) is ignored.
    const normalized = isEvChargingState(observation.value) ? observation.value : undefined;
    if (snapshot.evChargingState === normalized) return false;
    snapshot.evChargingState = normalized;
    snapshot.binaryControl = {
        on: resolveEvCurrentOn({
            evChargingState: snapshot.evChargingState,
            evchargerCharging: snapshot.evCharging,
        }),
    };
    const binaryEvidence = resolveEvChargingStateBinaryEvidence(normalized);
    if (binaryEvidence !== undefined && observation.source !== 'local_write') {
        snapshot.binaryControlObservation = {
            valid: true,
            capabilityId: 'evcharger_charging',
            observedValue: binaryEvidence,
            observedCapabilityIds: ['evcharger_charging_state'],
            observedAtMs: observation.observedAt,
            source: observation.source,
        };
    } else {
        delete snapshot.binaryControlObservation;
    }
    // Session-boundary tracking needs a known plug-state; a normalised-unknown
    // (`undefined`) transition has no session semantics.
    if (normalized !== undefined) {
        updateStateOfChargeSessionBoundary({
            snapshot,
            evChargingState: normalized,
            observedAtMs: observation.observedAt,
            nowMs: observation.observedAt,
        });
    }
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function applyMeasuredPowerObservation(
    nextSnapshot: TransportDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    if (
        typeof observation.value !== 'number'
        || !Number.isFinite(observation.value)
        || Object.is(snapshot.measuredPowerKw, observation.value)
    ) {
        return false;
    }
    snapshot.measuredPowerKw = observation.value;
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function applyMeasuredTemperatureObservation(
    nextSnapshot: TransportDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    if (
        typeof observation.value !== 'number'
        || !Number.isFinite(observation.value)
        || Object.is(snapshot.currentTemperature, observation.value)
    ) {
        return false;
    }
    snapshot.currentTemperature = observation.value;
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function applyStateOfChargeObservation(
    nextSnapshot: TransportDeviceSnapshot,
    capabilityId: string,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    const changed = updateStateOfChargeFromRealtimeCapability({
        snapshot,
        capabilityId,
        value: observation.value,
        observedAtMs: observation.observedAt,
    });
    if (!changed) return false;
    return true;
}

function applyTargetCapabilityObservation(
    nextSnapshot: TransportDeviceSnapshot,
    capabilityId: string,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    const target = snapshot.targets.find((entry) => entry.id === capabilityId);
    if (!target) {
        return false;
    }
    let nextValue: number | undefined | null;
    if (typeof observation.value === 'number' && Number.isFinite(observation.value)) {
        nextValue = observation.value;
    } else if (observation.value === undefined) {
        nextValue = undefined;
    } else {
        nextValue = null;
    }
    if (nextValue === null || Object.is(target.value, nextValue)) {
        return false;
    }
    if (nextValue === undefined) delete target.value;
    else target.value = nextValue;
    if (observation.source === 'local_write') {
        snapshot.lastLocalWriteMs = Math.max(snapshot.lastLocalWriteMs ?? 0, observation.observedAt);
        return true;
    }
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

export function clearCapabilityObservationIfMatched(
    state: DeviceTransportObservationState,
    deviceId: string,
    capabilityId: string,
    snapshot: TransportDeviceSnapshot,
): void {
    const key = buildCapabilityObservationKey(deviceId, capabilityId);
    const observation = state.capabilityObservations.get(key);
    if (!observation) return;
    if (isStateOfChargeCapabilityId(capabilityId)) {
        state.capabilityObservations.delete(key);
        return;
    }
    if (doesCapabilityObservationMatchSnapshot(snapshot, capabilityId, observation.value)) {
        state.capabilityObservations.delete(key);
    }
}

function doesCapabilityObservationMatchSnapshot(
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    observationValue: unknown,
): boolean {
    if (capabilityId === snapshot.controlCapabilityId) {
        return matchesCurrentControlObservation(snapshot, observationValue);
    }
    if (capabilityId === 'measure_power') {
        return snapshot.measuredPowerKw === observationValue;
    }
    if (capabilityId === 'measure_temperature') {
        return snapshot.currentTemperature === observationValue;
    }
    if (capabilityId === 'evcharger_charging_state') {
        return snapshot.evChargingState === observationValue;
    }
    const target = snapshot.targets.find((entry) => entry.id === capabilityId);
    return target ? Object.is(target.value, observationValue) : false;
}

function matchesCurrentControlObservation(
    snapshot: TransportDeviceSnapshot,
    observationValue: unknown,
): boolean {
    const currentControlValue = snapshot.controlCapabilityId === 'evcharger_charging'
        ? snapshot.evCharging
        : snapshot.binaryControl?.on;
    return currentControlValue === observationValue;
}
