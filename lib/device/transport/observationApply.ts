import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import {
    isEvChargingState,
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
import { resolveEvTargetPowerExactStep } from '../targetPowerReachability';
import { normalizeMeasuredPowerKw } from '../../../packages/shared-domain/src/measuredPowerObservedState';
import {
    removeTemperatureObservation,
    TARGET_TEMPERATURE_CAPABILITY_ID,
    updateTemperatureMeasurement,
    updateTemperatureTarget,
} from './temperatureObservation';

export function applyCapabilityObservation(
    nextSnapshot: TransportDeviceSnapshot,
    capabilityId: string,
    observation: CapabilityObservation,
): boolean {
    if (capabilityId === nextSnapshot.binaryCapabilityId) {
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
    if (snapshot.binaryCapabilityId === 'evcharger_charging') {
        snapshot.evCharging = observation.value;
        snapshot.evChargingObservedAtMs = observation.observedAt;
        snapshot.binaryControl = { on: observation.value };
    } else {
        snapshot.binaryControl = { on: observation.value };
    }
    if (
        previousCurrentOn === snapshot.binaryControl?.on
        && snapshot.binaryCapabilityId !== 'evcharger_charging'
    ) {
        return false;
    }
    if (
        previousCurrentOn === snapshot.binaryControl?.on
        && snapshot.binaryCapabilityId === 'evcharger_charging'
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
    // A value outside the Homey enum is a capability-contract violation, and the
    // contract is enforced by DROPPING the device at parse — an EV charger in the
    // snapshot always has a valid plug-state (`EvObservedFields`). So this seam
    // cannot write the violation inward: it ignores the event and lets the next
    // parse drop the device, which strands the prior state for at most one refresh
    // (~60 s, `STALE_OBSERVATION_FALLBACK_REFRESH_INTERVAL_MS`), with the measured
    // power axis contradicting a wrongly-retained "charging" belief meanwhile.
    // This reverses the previous rule here ("normalise to `undefined` and apply it,
    // never strand the stale state"), which could only be right while an EV device
    // was allowed to carry no plug-state at all.
    if (!isEvChargingState(observation.value)) return false;
    const normalized = observation.value;
    snapshot.evChargingStateObservedAtMs = observation.observedAt;
    if (snapshot.evChargingState === normalized) return false;
    snapshot.evChargingState = normalized;
    // Unconditional: the plug-state contract gate drops a device that reports a
    // non-enum value, so a normalised state is always known here.
    updateStateOfChargeSessionBoundary({
        snapshot,
        evChargingState: normalized,
        observedAtMs: observation.observedAt,
    });
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function applyMeasuredPowerObservation(
    nextSnapshot: TransportDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    // Same single rule as every other write seam; a rejected reading is absent.
    const kw = normalizeMeasuredPowerKw(observation.value);
    if (kw === null || Object.is(snapshot.measuredPowerKw, kw)) return false;
    snapshot.measuredPowerKw = kw;
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function applyMeasuredTemperatureObservation(
    nextSnapshot: TransportDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    const snapshot = nextSnapshot;
    if (typeof observation.value !== 'number' || !Number.isFinite(observation.value)) {
        return removeTemperatureObservation(snapshot);
    }
    if (!updateTemperatureMeasurement(snapshot, observation.value)) return false;
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
    if (capabilityId === TARGET_TEMPERATURE_CAPABILITY_ID) {
        return applyTemperatureTargetObservation(snapshot, observation);
    }
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
    if (nextValue === null) return false;
    const targetChanged = !Object.is(target.value, nextValue);
    if (targetChanged) {
        if (nextValue === undefined) delete target.value;
        else target.value = nextValue;
    }
    const exactObservationChanged = applyExactTargetPowerObservation({
        snapshot,
        capabilityId,
        observation,
        nextValue,
    });
    if (!targetChanged && !exactObservationChanged) return false;
    if (observation.source === 'local_write') {
        snapshot.lastLocalWriteMs = Math.max(snapshot.lastLocalWriteMs ?? 0, observation.observedAt);
        return true;
    }
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    return true;
}

function applyTemperatureTargetObservation(
    snapshot: TransportDeviceSnapshot,
    observation: CapabilityObservation,
): boolean {
    if (typeof observation.value !== 'number' || !Number.isFinite(observation.value)) {
        return observation.source === 'local_write' ? false : removeTemperatureObservation(snapshot);
    }
    const result = updateTemperatureTarget(snapshot, observation.value);
    if (!result.changed) return false;
    const mutableSnapshot = snapshot;
    if (observation.source === 'local_write') {
        mutableSnapshot.lastLocalWriteMs = Math.max(snapshot.lastLocalWriteMs ?? 0, observation.observedAt);
    } else {
        mutableSnapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAt);
        mutableSnapshot.lastUpdated = mutableSnapshot.lastFreshDataMs;
    }
    return true;
}

function applyExactTargetPowerObservation(params: {
    snapshot: TransportDeviceSnapshot;
    capabilityId: string;
    observation: CapabilityObservation;
    nextValue: number | undefined;
}): boolean {
    const {
        snapshot,
        capabilityId,
        observation,
        nextValue,
    } = params;
    if (capabilityId !== 'target_power' || observation.source === 'local_write' || nextValue === undefined) {
        return false;
    }
    const exactStep = resolveEvTargetPowerExactStep(snapshot.targetPowerConfig, nextValue);
    if (
        !exactStep
        || (
            snapshot.reportedStepId === exactStep.id
            && snapshot.reportedStepPowerW === exactStep.planningPowerW
            && snapshot.reportedStepObservedAtMs === observation.observedAt
        )
    ) {
        return false;
    }
    snapshot.reportedStepId = exactStep.id;
    snapshot.reportedStepPowerW = exactStep.planningPowerW;
    snapshot.reportedStepObservedAtMs = observation.observedAt;
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
    if (capabilityId === snapshot.binaryCapabilityId) {
        return matchesCurrentControlObservation(snapshot, observationValue);
    }
    if (capabilityId === 'measure_power') {
        return snapshot.measuredPowerKw === observationValue;
    }
    if (capabilityId === 'measure_temperature') {
        return typeof observationValue === 'number'
            && Number.isFinite(observationValue)
            && snapshot.temperature?.currentTemperature === observationValue;
    }
    if (capabilityId === 'evcharger_charging_state') {
        return snapshot.evChargingState === observationValue;
    }
    if (capabilityId === TARGET_TEMPERATURE_CAPABILITY_ID) {
        return typeof observationValue === 'number'
            && Number.isFinite(observationValue)
            && snapshot.temperature?.target.value === observationValue;
    }
    const target = snapshot.targets.find((entry) => entry.id === capabilityId);
    return target ? Object.is(target.value, observationValue) : false;
}

function matchesCurrentControlObservation(
    snapshot: TransportDeviceSnapshot,
    observationValue: unknown,
): boolean {
    const currentControlValue = snapshot.binaryCapabilityId === 'evcharger_charging'
        ? snapshot.evCharging
        : snapshot.binaryControl?.on;
    return currentControlValue === observationValue;
}
