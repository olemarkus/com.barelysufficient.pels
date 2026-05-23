import {
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { DeviceObjectiveProfileSample } from './types';

export const OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS = 30 * 60 * 1000;
export const OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS = 5 * 1000;

export function buildObjectiveProfileSample(
  device: TargetDeviceSnapshot,
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

  if (device.deviceClass === 'evcharger' && device.stateOfCharge?.status === 'fresh') {
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
  device: TargetDeviceSnapshot,
  nowMs: number,
): device is TargetDeviceSnapshot & { currentTemperature: number; lastFreshDataMs: number } {
  return device.deviceType === 'temperature'
    && typeof device.currentTemperature === 'number'
    && Number.isFinite(device.currentTemperature)
    && typeof device.lastFreshDataMs === 'number'
    && Number.isFinite(device.lastFreshDataMs)
    && isFreshObservationTime(device.lastFreshDataMs, nowMs);
}

function isFreshObservationTime(observedAtMs: number, nowMs: number): boolean {
  return observedAtMs <= nowMs + OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS
    && nowMs - observedAtMs <= OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS;
}

function resolveCredibleDevicePower(
  device: TargetDeviceSnapshot,
): Pick<DeviceObjectiveProfileSample, 'crediblePowerW' | 'powerSource'> {
  if (
    typeof device.measuredPowerKw === 'number'
    && Number.isFinite(device.measuredPowerKw)
    && device.measuredPowerKw > 0
  ) {
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
