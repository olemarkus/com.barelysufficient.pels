import type { EvChargingState } from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { isEvChargingState } from '../../../packages/shared-domain/src/evPlugState';
import {
  isStateOfChargeCapabilityId,
  updateStateOfChargeFromRealtimeCapability,
  updateStateOfChargeSessionBoundary,
} from './stateOfCharge';
import type { RealtimeDeviceReconcileChange } from '../managerRuntime';
import { normalizeMeasuredPowerKw } from '../../../packages/shared-domain/src/measuredPowerObservedState';
import {
  removeTemperatureObservation,
  updateTemperatureMeasurement,
} from './temperatureObservation';

export type FreshnessOnlyCapabilityUpdateResult = {
  changed: boolean;
  normalizedValue: unknown;
  reconcileChange?: RealtimeDeviceReconcileChange;
  temperatureRecoveryRequested?: boolean;
  temperatureFacetRemoved?: boolean;
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
  if (capabilityId === 'measure_temperature') return applyTemperatureUpdate(snapshot, value);
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

function applyTemperatureUpdate(
  snapshot: TransportDeviceSnapshot,
  value: unknown,
): FreshnessOnlyCapabilityUpdateResult {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const removed = removeTemperatureObservation(snapshot);
    return {
      changed: removed,
      normalizedValue: undefined,
      temperatureFacetRemoved: removed,
    };
  }
  if (!snapshot.temperature) {
    return {
      changed: false,
      normalizedValue: value,
      temperatureRecoveryRequested: true,
    };
  }
  return {
    changed: updateTemperatureMeasurement(snapshot, value),
    normalizedValue: value,
  };
}

function applyEvChargingStateUpdate(
  snapshot: TransportDeviceSnapshot,
  value: EvChargingState | undefined,
): FreshnessOnlyCapabilityUpdateResult {
  const mutableSnapshot = snapshot;
  const observedAtMs = Date.now();
  mutableSnapshot.evChargingStateObservedAtMs = observedAtMs;
  if (Object.is(mutableSnapshot.evChargingState, value)) {
    return { changed: false, normalizedValue: value };
  }
  mutableSnapshot.evChargingState = value;
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
  };
}
