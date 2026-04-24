import type { TargetDeviceSnapshot } from '../utils/types';
import { resolveEvCurrentOn } from './deviceManagerControl';
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
  if (capabilityId === 'evcharger_charging_state' && typeof value === 'string') {
    if (Object.is(snapshot.evChargingState, value)) return { changed: false, normalizedValue: value };
    const previousCurrentOn = snapshot.currentOn;
    snapshot.evChargingState = value;
    const nextCurrentOn = resolveEvCurrentOn({
      evChargingState: snapshot.evChargingState,
      evchargerCharging: snapshot.evCharging,
    });
    snapshot.currentOn = nextCurrentOn;
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
