import type { EvChargingState } from '../../../packages/contracts/src/types';
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
import { formatBinaryState } from './managerRealtimeSupport';
import type { RealtimeDeviceReconcileChange } from '../managerRuntime';
import { normalizeMeasuredPowerKw } from '../../../packages/shared-domain/src/measuredPowerObservedState';

export type FreshnessOnlyCapabilityUpdateResult = {
  changed: boolean;
  normalizedValue: unknown;
  reconcileChange?: RealtimeDeviceReconcileChange;
  binaryControlObservation?: TransportDeviceSnapshot['binaryControlObservation'];
};

export function applyFreshnessOnlyCapabilityUpdate(params: {
  snapshot: TransportDeviceSnapshot;
  capabilityId: string;
  value: unknown;
}): FreshnessOnlyCapabilityUpdateResult {
  const { snapshot, capabilityId, value } = params;
  // `normalizeMeasuredPowerKw` is the shared rule every `measuredPowerKw` write
  // seam applies (`resolveMeasuredPowerKw` at parse, `applyMeasuredPowerObservation`
  // at snapshot-refresh, `getCurrentDrawKw` at the plan producer), so a realtime
  // `NaN`/`Infinity`/negative power event from the Homey live feed is DROPPED
  // rather than polluting the snapshot. Junk is validated out at the boundary,
  // not propagated to the power sum / shed decisions downstream.
  // One rule for every write seam. A rejected reading is ABSENT — `null` here, so
  // it falls through to the no-op return below with no write and no freshness
  // bump — and is never floored to 0, because "no reading" and "drawing nothing"
  // are different facts.
  const measuredKw = capabilityId === 'measure_power'
    ? normalizeMeasuredPowerKw(typeof value === 'number' ? value / 1000 : value)
    : null;
  if (measuredKw !== null) {
    if (Object.is(snapshot.measuredPowerKw, measuredKw)) {
      return { changed: false, normalizedValue: measuredKw };
    }
    snapshot.measuredPowerKw = measuredKw;
    return { changed: true, normalizedValue: measuredKw };
  }
  // Same `Number.isFinite` boundary gate as `measure_power` above and the other
  // two `currentTemperature` write seams (`getCurrentTemperature` at parse,
  // `applyMeasuredTemperatureObservation` at snapshot-refresh) so "present
  // implies finite" holds at EVERY producer seam — the invariant the
  // `TemperatureObservedFields` consumers rely on when they read the narrowed
  // field without a finiteness re-check. A non-finite realtime `measure_temperature`
  // event is not a usable reading: skip the write (and the freshness bump).
  if (capabilityId === 'measure_temperature' && typeof value === 'number' && Number.isFinite(value)) {
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
  snapshot: TransportDeviceSnapshot,
  value: EvChargingState | undefined,
): FreshnessOnlyCapabilityUpdateResult {
  const mutableSnapshot = snapshot;
  const observedAtMs = Date.now();
  mutableSnapshot.evChargingStateObservedAtMs = observedAtMs;
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
    observedCapabilityId: 'evcharger_charging_state',
    previousValue: formatBinaryState(previousCurrentOn),
    nextValue: formatBinaryState(nextCurrentOn),
  };
}

function buildEvChargingStateBinaryControlObservation(
  value: EvChargingState | undefined,
  observedAtMs: number,
): TransportDeviceSnapshot['binaryControlObservation'] {
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
