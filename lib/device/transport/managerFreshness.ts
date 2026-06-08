import type { EvChargingState, TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
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
import { formatBinaryState } from './managerRealtimeSupport';
import type { RealtimeDeviceReconcileChange } from '../managerRuntime';

export type FreshnessOnlyCapabilityUpdateResult = {
  changed: boolean;
  normalizedValue: unknown;
  reconcileChange?: RealtimeDeviceReconcileChange;
  binaryControlObservation?: TargetDeviceSnapshot['binaryControlObservation'];
};

export function applyFreshnessOnlyCapabilityUpdate(params: {
  snapshot: TargetDeviceSnapshot;
  capabilityId: string;
  value: unknown;
}): FreshnessOnlyCapabilityUpdateResult {
  const { snapshot, capabilityId, value } = params;
  if (capabilityId === 'measure_power' && typeof value === 'number') {
    const kw = value / 1000;
    if (Object.is(snapshot.measuredPowerKw, kw)) return { changed: false, normalizedValue: kw };
    snapshot.measuredPowerKw = kw;
    return { changed: true, normalizedValue: kw };
  }
  if (capabilityId === 'measure_temperature' && typeof value === 'number') {
    if (Object.is(snapshot.currentTemperature, value)) return { changed: false, normalizedValue: value };
    snapshot.currentTemperature = value;
    return { changed: true, normalizedValue: value };
  }
  if (isStateOfChargeCapabilityId(capabilityId)) {
    const observedAtMs = Date.now();
    const changed = updateStateOfChargeFromRealtimeCapability({
      snapshot,
      capabilityId,
      value,
      observedAtMs,
    });
    return {
      changed,
      normalizedValue: snapshot.stateOfCharge?.percent,
    };
  }
  if (capabilityId === 'evcharger_charging_state' && typeof value === 'string') {
    // An explicit out-of-enum value is new information (the charger left a known
    // state), so normalise it to `undefined` and APPLY the transition — do not
    // drop the update, which would strand the stale (possibly commandable)
    // prior state. A non-string value falls through and is ignored.
    return applyEvChargingStateUpdate(snapshot, isEvChargingState(value) ? value : undefined);
  }
  return { changed: false, normalizedValue: undefined };
}

function applyEvChargingStateUpdate(
  snapshot: TargetDeviceSnapshot,
  value: EvChargingState | undefined,
): FreshnessOnlyCapabilityUpdateResult {
  const mutableSnapshot = snapshot;
  const observedAtMs = Date.now();
  const binaryControlObservation = buildEvChargingStateBinaryControlObservation(value, observedAtMs);
  if (binaryControlObservation) mutableSnapshot.binaryControlObservation = binaryControlObservation;
  else delete mutableSnapshot.binaryControlObservation;
  if (Object.is(mutableSnapshot.evChargingState, value)) {
    return { changed: false, normalizedValue: value, binaryControlObservation };
  }
  const previousCurrentOn = mutableSnapshot.binaryControl?.on ?? true;
  mutableSnapshot.evChargingState = value;
  const nextCurrentOn = resolveEvCurrentOn({
    evChargingState: mutableSnapshot.evChargingState,
    evchargerCharging: mutableSnapshot.evCharging,
  });
  mutableSnapshot.binaryControl = { on: nextCurrentOn };
  // Session-boundary tracking is only meaningful for a known plug-state; a
  // normalised-unknown (`undefined`) transition has no session semantics.
  if (value !== undefined) {
    updateStateOfChargeSessionBoundary({
      snapshot: mutableSnapshot,
      evChargingState: value,
      observedAtMs,
      nowMs: observedAtMs,
    });
  }
  return {
    changed: true,
    normalizedValue: value,
    binaryControlObservation,
    reconcileChange: buildEvChargingStateReconcileChange(previousCurrentOn, nextCurrentOn),
  };
}

function buildEvChargingStateReconcileChange(
  previousCurrentOn: boolean,
  nextCurrentOn: boolean,
): RealtimeDeviceReconcileChange | undefined {
  if (previousCurrentOn === nextCurrentOn) return undefined;
  return {
    capabilityId: 'evcharger_charging',
    previousValue: formatBinaryState(previousCurrentOn),
    nextValue: formatBinaryState(nextCurrentOn),
  };
}

function buildEvChargingStateBinaryControlObservation(
  value: EvChargingState | undefined,
  observedAtMs: number,
): TargetDeviceSnapshot['binaryControlObservation'] {
  const observedValue = resolveEvChargingStateBinaryEvidence(value);
  if (observedValue === undefined) return undefined;
  return {
    valid: true,
    capabilityId: 'evcharger_charging',
    observedValue,
    observedCapabilityIds: ['evcharger_charging_state'],
    observedAtMs,
    source: 'realtime_capability',
  };
}
