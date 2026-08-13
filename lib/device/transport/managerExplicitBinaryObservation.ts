import type { HomeyDeviceLike } from '../../utils/types';
import {
  resolveEvCurrentOn,
  toCapabilityTimestampMs,
} from '../managerControl';
import { resolveBinaryOn } from '../../utils/binaryControl';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';

export type ExplicitControlObservation = {
  binaryCapabilityId: NonNullable<TransportDeviceSnapshot['binaryCapabilityId']>;
  value: boolean;
  observedCapabilityId: string;
};

export function applyExplicitBinaryObservation(params: {
  parsed: TransportDeviceSnapshot;
  observation: ExplicitControlObservation;
  observedAtMs?: number;
}): void {
  const {
    parsed,
    observation: {
      binaryCapabilityId,
      value,
      observedCapabilityId,
    },
    observedAtMs,
  } = params;
  if (binaryCapabilityId === 'evcharger_charging') {
    if (observedCapabilityId === 'evcharger_charging') {
      parsed.evCharging = value;
      if (observedAtMs !== undefined) parsed.evChargingObservedAtMs = observedAtMs;
    } else if (observedAtMs !== undefined) {
      parsed.evChargingStateObservedAtMs = observedAtMs;
    }
    parsed.binaryControl = {
      on: resolveEvCurrentOn({
        evchargerCharging: parsed.evCharging,
      }),
    };
  } else {
    parsed.binaryControl = { on: value };
  }
  if (observedAtMs === undefined) return;
  parsed.binaryControlObservation = {
    valid: true,
    capabilityId: binaryCapabilityId,
    observedValue: value,
    observedCapabilityIds: [observedCapabilityId],
    observedAtMs,
    source: 'device_update',
  };
}

export function resolveExplicitBinaryEvidence(params: {
  device: HomeyDeviceLike;
  previous: TransportDeviceSnapshot | null;
  observation: ExplicitControlObservation;
  receivedAtMs: number;
}): { accepted: boolean; observedAtMs?: number } {
  const {
    device, previous, observation, receivedAtMs,
  } = params;
  const sourceObservedAtMs = toCapabilityTimestampMs(
    device.capabilitiesObj?.[observation.observedCapabilityId]?.lastUpdated,
  );
  if (!previous) {
    return {
      accepted: true,
      observedAtMs: sourceObservedAtMs ?? receivedAtMs,
    };
  }
  const previousEvidence = resolvePreviousExplicitBinaryEvidence(previous, observation);
  if (
    sourceObservedAtMs !== undefined
    && previousEvidence.observedAtMs !== undefined
    && sourceObservedAtMs <= previousEvidence.observedAtMs
  ) {
    return { accepted: false };
  }
  if (sourceObservedAtMs !== undefined) {
    return { accepted: true, observedAtMs: sourceObservedAtMs };
  }
  if (previousEvidence.value !== observation.value) {
    return { accepted: true, observedAtMs: receivedAtMs };
  }
  return {
    accepted: true,
    observedAtMs: previousEvidence.observedAtMs ?? receivedAtMs,
  };
}

export function preserveStaleBundledEvState(params: {
  device: HomeyDeviceLike;
  parsed: TransportDeviceSnapshot;
  previous: TransportDeviceSnapshot | null;
  observation: ExplicitControlObservation;
}): void {
  const {
    device, parsed, previous, observation,
  } = params;
  if (
    !previous
    || observation.binaryCapabilityId !== 'evcharger_charging'
    || observation.observedCapabilityId !== 'evcharger_charging'
  ) return;
  const previousStateObservedAtMs = previous.evChargingStateObservedAtMs;
  const incomingStateObservedAtMs = toCapabilityTimestampMs(
    device.capabilitiesObj?.evcharger_charging_state?.lastUpdated,
  );
  if (
    previousStateObservedAtMs === undefined
    || incomingStateObservedAtMs === undefined
    || incomingStateObservedAtMs > previousStateObservedAtMs
  ) return;
  parsed.evChargingState = previous.evChargingState;
  parsed.evChargingStateObservedAtMs = previousStateObservedAtMs;
}

function resolvePreviousExplicitBinaryEvidence(
  previous: TransportDeviceSnapshot,
  observation: ExplicitControlObservation,
): { value?: boolean; observedAtMs?: number } {
  const rawEvAxis = (
    observation.binaryCapabilityId === 'evcharger_charging'
    && observation.observedCapabilityId === 'evcharger_charging'
  );
  if (rawEvAxis) {
    return {
      value: previous.evCharging,
      observedAtMs: previous.evChargingObservedAtMs,
    };
  }
  const previousObservation = previous.binaryControlObservation;
  if (observation.observedCapabilityId === 'evcharger_charging_state') {
    return {
      value: previousObservation?.observedCapabilityIds.includes('evcharger_charging_state')
        ? previousObservation.observedValue
        : resolveBinaryOn(previous),
      observedAtMs: previous.evChargingStateObservedAtMs,
    };
  }
  if (
    previousObservation?.capabilityId === observation.binaryCapabilityId
    && previousObservation.observedCapabilityIds.includes(observation.observedCapabilityId)
  ) {
    return {
      value: previousObservation.observedValue,
      observedAtMs: previousObservation.observedAtMs,
    };
  }
  return { value: resolveBinaryOn(previous) };
}

export function preserveRejectedExplicitBinaryObservation(params: {
  parsed: TransportDeviceSnapshot;
  previous: TransportDeviceSnapshot;
  observation: ExplicitControlObservation;
}): void {
  const { parsed, previous, observation } = params;
  if (
    observation.binaryCapabilityId === 'evcharger_charging'
    && observation.observedCapabilityId === 'evcharger_charging'
  ) {
    if (parsed.evChargingStateObservedAtMs === undefined) {
      parsed.evChargingState = previous.evChargingState;
      parsed.evChargingStateObservedAtMs = previous.evChargingStateObservedAtMs;
    }
    parsed.evCharging = previous.evCharging;
    parsed.evChargingObservedAtMs = previous.evChargingObservedAtMs;
    parsed.binaryControl = {
      on: resolveEvCurrentOn({
        evchargerCharging: parsed.evCharging,
      }),
    };
    const previousStateObservedAtMs = previous.evChargingStateObservedAtMs;
    const parsedStateObservedAtMs = parsed.evChargingStateObservedAtMs;
    if (
      previous.binaryControlObservation
      && (
        previousStateObservedAtMs === undefined
        || parsedStateObservedAtMs === undefined
        || parsedStateObservedAtMs <= previousStateObservedAtMs
      )
    ) {
      parsed.binaryControlObservation = {
        ...previous.binaryControlObservation,
        observedCapabilityIds: [...previous.binaryControlObservation.observedCapabilityIds],
      };
    }
    return;
  }
  if (observation.binaryCapabilityId === 'evcharger_charging') {
    parsed.evChargingState = previous.evChargingState;
    parsed.evChargingStateObservedAtMs = previous.evChargingStateObservedAtMs;
    parsed.binaryControl = {
      on: resolveEvCurrentOn({
        evchargerCharging: parsed.evCharging,
      }),
    };
  } else {
    parsed.binaryControl = { on: resolveBinaryOn(previous) };
  }
  if (previous.binaryControlObservation) {
    parsed.binaryControlObservation = {
      ...previous.binaryControlObservation,
      observedCapabilityIds: [...previous.binaryControlObservation.observedCapabilityIds],
    };
  } else {
    delete parsed.binaryControlObservation;
  }
}
