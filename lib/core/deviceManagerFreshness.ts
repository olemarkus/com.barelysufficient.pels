import type { TargetDeviceSnapshot } from '../utils/types';
import { resolveEvCurrentOn } from './deviceManagerControl';
import {
  isStateOfChargeCapabilityId,
  updateStateOfChargeFromRealtimeCapability,
  updateStateOfChargeSessionBoundary,
} from './deviceStateOfCharge';
import { formatBinaryState } from './deviceManagerRealtimeSupport';
import type { RealtimeDeviceReconcileChange } from './deviceManagerRuntime';

export type FreshnessOnlyCapabilityUpdateResult = {
  changed: boolean;
  normalizedValue: unknown;
  reconcileChange?: RealtimeDeviceReconcileChange;
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
    if (Object.is(snapshot.evChargingState, value)) return { changed: false, normalizedValue: value };
    const previousCurrentOn = snapshot.currentOn;
    snapshot.evChargingState = value;
    const nextCurrentOn = resolveEvCurrentOn({
      evChargingState: snapshot.evChargingState,
      evchargerCharging: snapshot.evCharging,
    });
    snapshot.currentOn = nextCurrentOn;
    updateStateOfChargeSessionBoundary({
      snapshot,
      evChargingState: value,
      observedAtMs: Date.now(),
      nowMs: Date.now(),
    });
    return {
      changed: true,
      normalizedValue: value,
      reconcileChange: previousCurrentOn === nextCurrentOn
        ? undefined
        : {
          capabilityId: 'evcharger_charging',
          previousValue: formatBinaryState(previousCurrentOn),
          nextValue: formatBinaryState(nextCurrentOn),
        },
    };
  }
  return { changed: false, normalizedValue: undefined };
}
