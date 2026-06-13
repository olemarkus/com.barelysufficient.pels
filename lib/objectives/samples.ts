import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import { isEvDevice } from '../../packages/shared-domain/src/commandableNow';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import { hasObservedTemperature } from '../../packages/shared-domain/src/temperatureObservedState';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import type {
  DeviceDescriptor,
  MeasuredPowerObservedProbe,
  ObservedDeviceState,
  StateOfChargeObservedProbe,
  TemperatureObservedProbe,
} from '../../packages/contracts/src/types';
import type { DeviceObjectiveProfileSample } from './types';

// Observed truth (temperature / SoC / measured power / reported step) plus the
// few descriptor fields the kind predicates need — NOT the full producer-input
// `TargetDeviceSnapshot`. Objectives is a downstream consumer; it depends on the
// decomposed snapshot halves, never the raw producer snapshot. The
// `TemperatureObservedProbe` / `StateOfChargeObservedProbe` /
// `MeasuredPowerObservedProbe` widenings carry the observed temperature / SoC /
// measured power the base type omits (this is a producer-fed funnel);
// `hasObservedTemperature` / `hasObservedStateOfCharge` /
// `hasObservedMeasuredPower` narrow them.
export type ObjectiveSampleDevice = ObservedDeviceState
  & TemperatureObservedProbe
  & StateOfChargeObservedProbe
  & MeasuredPowerObservedProbe
  & Pick<DeviceDescriptor, 'steppedLoadProfile' | 'deviceClass' | 'deviceType' | 'controlCapabilityId'>;

export const OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS = 30 * 60 * 1000;
export const OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS = 5 * 1000;

export function buildObjectiveProfileSample(
  device: ObjectiveSampleDevice,
  nowMs: number,
): DeviceObjectiveProfileSample | null {
  if (isFreshTemperatureDevice(device, nowMs)) {
    return {
      observedAtMs: device.lastFreshDataMs,
      value: Math.round(device.currentTemperature * 10) / 10,
      unit: 'degree_c',
      ...resolveCredibleDevicePower(device),
    };
  }

  if (isEvDevice(device) && hasObservedStateOfCharge(device) && device.stateOfCharge.status === 'fresh') {
    const observedAtMs = device.stateOfCharge.observedAtMs ?? device.lastFreshDataMs;
    if (typeof observedAtMs !== 'number' || !Number.isFinite(observedAtMs)) return null;
    if (!isFreshObservationTime(observedAtMs, nowMs)) return null;
    if (!Number.isFinite(device.stateOfCharge.percent)) return null;
    return {
      observedAtMs,
      value: device.stateOfCharge.percent,
      unit: 'percent',
      ...resolveCredibleDevicePower(device),
    };
  }

  return null;
}

function isFreshTemperatureDevice(
  device: ObjectiveSampleDevice,
  nowMs: number,
): device is ObjectiveSampleDevice & { currentTemperature: number; lastFreshDataMs: number } {
  // `hasObservedTemperature` proves `currentTemperature` is a finite `number`
  // (producer invariant), so no `typeof`/`Number.isFinite` re-check here — the
  // kind question is asked separately via `isTemperatureControlDevice`.
  return isTemperatureControlDevice(device)
    && hasObservedTemperature(device)
    && typeof device.lastFreshDataMs === 'number'
    && Number.isFinite(device.lastFreshDataMs)
    && isFreshObservationTime(device.lastFreshDataMs, nowMs);
}

function isFreshObservationTime(observedAtMs: number, nowMs: number): boolean {
  return observedAtMs <= nowMs + OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS
    && nowMs - observedAtMs <= OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS;
}

function resolveCredibleDevicePower(
  device: ObjectiveSampleDevice,
): Pick<DeviceObjectiveProfileSample, 'crediblePowerW' | 'powerSource'> {
  // `hasObservedMeasuredPower` proves `measuredPowerKw` is a finite `number`
  // (producer invariant — the write seams store only `Number.isFinite` values),
  // so no `typeof`/`Number.isFinite` re-check here; `> 0` is the positive-draw
  // gate (a measured 0 W is not credible device power), which stays.
  if (hasObservedMeasuredPower(device) && device.measuredPowerKw > 0) {
    return {
      crediblePowerW: Math.round(device.measuredPowerKw * 1000),
      powerSource: 'measured',
    };
  }

  const profile = device.steppedLoadProfile;
  if (!profile) return {};
  const reportedStep = getSteppedLoadStep(profile, device.reportedStepId);
  if (reportedStep && !isSteppedLoadOffStep(profile, reportedStep.id) && reportedStep.planningPowerW > 0) {
    return {
      crediblePowerW: Math.round(reportedStep.planningPowerW),
      powerSource: 'reported_step_planning',
    };
  }

  return {};
}
