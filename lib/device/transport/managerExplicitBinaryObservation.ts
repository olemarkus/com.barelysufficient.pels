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
  observedAtMs: number;
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
      parsed.evChargingObservedAtMs = observedAtMs;
    } else {
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
  parsed.binaryControlObservation = {
    valid: true,
    capabilityId: binaryCapabilityId,
    observedValue: value,
    observedCapabilityIds: [observedCapabilityId],
    observedAtMs,
    source: 'device_update',
  };
}

/**
 * Whether a `device.update`'s explicit binary value is newer evidence than what
 * the snapshot holds. The source's own stamp decides: the device-read contract
 * guarantees a conforming update carries one, so a value is never placed on an
 * arrival time instead.
 */
export function resolveExplicitBinaryEvidence(params: {
  device: HomeyDeviceLike;
  previous: TransportDeviceSnapshot | null;
  observation: ExplicitControlObservation;
}): { accepted: true; observedAtMs: number } | { accepted: false } {
  const { device, previous, observation } = params;
  const sourceObservedAtMs = toCapabilityTimestampMs(
    device.capabilitiesObj?.[observation.observedCapabilityId]?.lastUpdated,
  );
  if (sourceObservedAtMs === undefined) return { accepted: false };
  const previousObservedAtMs = previous === null
    ? undefined
    : resolvePreviousExplicitBinaryObservedAtMs(previous, observation);
  if (previousObservedAtMs !== undefined && sourceObservedAtMs <= previousObservedAtMs) {
    return { accepted: false };
  }
  return { accepted: true, observedAtMs: sourceObservedAtMs };
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

function resolvePreviousExplicitBinaryObservedAtMs(
  previous: TransportDeviceSnapshot,
  observation: ExplicitControlObservation,
): number | undefined {
  if (
    observation.binaryCapabilityId === 'evcharger_charging'
    && observation.observedCapabilityId === 'evcharger_charging'
  ) {
    return previous.evChargingObservedAtMs;
  }
  if (observation.observedCapabilityId === 'evcharger_charging_state') {
    return previous.evChargingStateObservedAtMs;
  }
  const previousObservation = previous.binaryControlObservation;
  if (
    previousObservation?.capabilityId === observation.binaryCapabilityId
    && previousObservation.observedCapabilityIds.includes(observation.observedCapabilityId)
  ) {
    return previousObservation.observedAtMs;
  }
  return undefined;
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
