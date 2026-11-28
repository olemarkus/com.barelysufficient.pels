import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { isEvDevice, isEvPlugStateIdle, isEvSessionInactive } from '../../packages/shared-domain/src/evPlugState';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { hasStorageInput } from '../plan/battery/storageLadder';
import type { ObservedStorageInput } from '../../packages/planner-types/src/planInputDevice';
import type { UnrankedPlanInputDevice } from './planInputDeviceTypes';
import type { PlanInputSnapshotDevice } from './runtimeDeviceRead';

/** Ignore charger standby draw. Only direct power evidence can start a hold. */
const EV_CHARGING_THRESHOLD_KW = 0.5;

function isObservedCharging(device: PlanInputSnapshotDevice): boolean {
  if (!isEvDevice(device) || !device.available || !hasObservedMeasuredPower(device)
    || !device.measuredPowerIsDirectMeasurement || device.measuredPowerKw < EV_CHARGING_THRESHOLD_KW) return false;
  if (!isEvObserved(device) || device.evChargingStateObservedAtMs === undefined
    || device.measuredPowerObservedAtMs === undefined
    || device.evChargingStateObservedAtMs < device.measuredPowerObservedAtMs) return true;

  // A newer session report can end charging before the power value changes.
  const state = device.evChargingState;
  return !isEvSessionInactive(state) && !isEvPlugStateIdle(state) && state !== 'plugged_in_paused';
}

function observesEvCharging(
  device: UnrankedPlanInputDevice,
): device is UnrankedPlanInputDevice & { storage: ObservedStorageInput } {
  return hasStorageInput(device) && device.storage.reading === 'observed'
    && device.storage.holdDischargeDuringEvCharging === true;
}

/** Carry same-home draw into storage planning without granting control of the charger. */
export function withObservedEvCharging(
  plannedDevices: UnrankedPlanInputDevice[],
  homeDevices: readonly PlanInputSnapshotDevice[],
): UnrankedPlanInputDevice[] {
  if (!plannedDevices.some(observesEvCharging) || !homeDevices.some(isObservedCharging)) return plannedDevices;

  return plannedDevices.map((device) => (observesEvCharging(device)
    ? { ...device, storage: { ...device.storage, evChargingObserved: true } } : device));
}
