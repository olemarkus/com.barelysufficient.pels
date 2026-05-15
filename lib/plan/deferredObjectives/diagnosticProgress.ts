/**
 * Progress resolvers for the deferred-objective diagnostic bridge. Splits
 * out so the bridge file stays under the 500 LOC eslint cap.
 *
 * Returns whether the device's current SoC / temperature is fresh enough to
 * feed the bucket allocator, plus the reason code the bridge surfaces when
 * progress is unavailable.
 */
import {
  OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS,
  OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS,
} from '../../core/objectiveProfiles';
import { isDeviceObservationTrusted } from '../../observer/observationTrust';
import type { PlanInputDevice } from '../planTypes';
import type { DeferredObjectiveSettingsEntry } from './settings';

export type DeferredObjectiveProgressResolution = {
  remainingUnits: number;
  currentPercent: number | null;
  currentTemperatureC: number | null;
  reasonCode: null;
} | {
  remainingUnits: 0;
  currentPercent: number | null;
  currentTemperatureC: number | null;
  reasonCode: 'objective_invalid_session' | 'objective_missing_temperature' | 'objective_progress_stale';
};

type EvProgress = {
  currentPercent: number;
  reasonCode: null;
} | {
  currentPercent: number | null;
  reasonCode: 'objective_invalid_session' | 'objective_progress_stale';
};

const resolveEvObjectiveProgress = (device: PlanInputDevice): EvProgress => {
  if (device.evChargingState === 'plugged_out' || device.evChargingState === 'plugged_in_discharging') {
    return { currentPercent: null, reasonCode: 'objective_invalid_session' };
  }
  const stateOfCharge = device.stateOfCharge;
  if (!stateOfCharge || stateOfCharge.status !== 'fresh' || !Number.isFinite(stateOfCharge.percent)) {
    return {
      currentPercent: typeof stateOfCharge?.percent === 'number' && Number.isFinite(stateOfCharge.percent)
        ? stateOfCharge.percent
        : null,
      reasonCode: stateOfCharge?.status === 'invalid' ? 'objective_invalid_session' : 'objective_progress_stale',
    };
  }
  return { currentPercent: stateOfCharge.percent, reasonCode: null };
};

const hasFreshTemperatureProgress = (params: {
  device: PlanInputDevice;
  nowMs: number;
}): params is { device: PlanInputDevice & { currentTemperature: number; lastFreshDataMs: number }; nowMs: number } => {
  const { device, nowMs } = params;
  if (!isDeviceObservationTrusted(device)) return false;
  if (typeof device.currentTemperature !== 'number' || !Number.isFinite(device.currentTemperature)) return false;
  if (typeof device.lastFreshDataMs !== 'number' || !Number.isFinite(device.lastFreshDataMs)) return false;
  if (device.lastFreshDataMs > nowMs + OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS) return false;
  return nowMs - device.lastFreshDataMs <= OBJECTIVE_PROFILE_MAX_OBSERVATION_AGE_MS;
};

export const resolveObjectiveProgress = (params: {
  objective: DeferredObjectiveSettingsEntry;
  device: PlanInputDevice;
  nowMs: number;
}): DeferredObjectiveProgressResolution => {
  const { objective, device, nowMs } = params;
  if (objective.kind === 'ev_soc') {
    const progress = resolveEvObjectiveProgress(device);
    if (progress.reasonCode) {
      return {
        remainingUnits: 0,
        currentPercent: progress.currentPercent,
        currentTemperatureC: null,
        reasonCode: progress.reasonCode,
      };
    }
    return {
      remainingUnits: Math.max(0, objective.targetPercent - progress.currentPercent),
      currentPercent: progress.currentPercent,
      currentTemperatureC: null,
      reasonCode: null,
    };
  }

  const currentTemperatureC = device.currentTemperature;
  if (!hasFreshTemperatureProgress({ device, nowMs })) {
    return {
      remainingUnits: 0,
      currentPercent: null,
      currentTemperatureC: typeof currentTemperatureC === 'number' && Number.isFinite(currentTemperatureC)
        ? currentTemperatureC
        : null,
      reasonCode: typeof currentTemperatureC === 'number' && Number.isFinite(currentTemperatureC)
        ? 'objective_progress_stale'
        : 'objective_missing_temperature',
    };
  }
  const freshTemperatureC = Number(device.currentTemperature);
  return {
    remainingUnits: Math.max(0, objective.targetTemperatureC - freshTemperatureC),
    currentPercent: null,
    currentTemperatureC: freshTemperatureC,
    reasonCode: null,
  };
};
