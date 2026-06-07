/**
 * Progress resolvers for the deferred-objective diagnostic bridge. Splits
 * out so the bridge file stays under the 500 LOC eslint cap.
 *
 * Returns whether the device's current SoC / temperature is usable to feed
 * the bucket allocator, plus the reason code the bridge surfaces when
 * progress is unavailable.
 *
 * Temperature thermostats only push capability updates on value change (see
 * `lib/observer/observationFreshness.ts`), so a perfectly working device
 * steady at setpoint can sit aged-out indefinitely. Smart-task planning
 * therefore credits the last-seen temperature for any device that has ever
 * produced a trusted observation, and only suppresses planning when the
 * device has never reported a value at all (`lastFreshDataMs` absent —
 * mirrors `getDeviceObservationFreshness === 'unknown'`). Note: this gate
 * deliberately does **not** consult `observationStale`, because in this
 * repo today that flag is produced by the same age-based heuristic
 * (`appInit.ts` → `isDeviceObservationStale`) — re-applying it here would
 * just reinstate the bug.
 *
 * EV SoC stays strictly fresh because charger session validity genuinely
 * requires per-session telemetry.
 *
 * Stuck-sensor residual risk: a thermostat alive on the radio but reporting
 * a fixed wrong value will be planned against that wrong value. The whole
 * Homey state model assumes capability readings are trustworthy, so every
 * consumer (this app, native thermostat schedules, other Homey apps) is
 * vulnerable to the same failure mode. Containment is upstream — capacity
 * guard and daily budget bound the energy blast radius, and the divergence
 * between the sensor and reality is visible to the user. PELS specifically
 * does not try to detect this.
 */
import { OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS } from '../../objectives/profiles';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import type { DeferredObjectiveSettingsEntry } from './settings';
import { isEvSessionInactiveForDevice } from '../../../packages/shared-domain/src/commandableNow';

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

const resolveEvObjectiveProgress = (device: ObjectiveDeviceInput): EvProgress => {
  if (isEvSessionInactiveForDevice(device)) {
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

const hasUsableTemperatureProgress = (params: {
  device: ObjectiveDeviceInput;
  nowMs: number;
}): params is {
  device: ObjectiveDeviceInput & { currentTemperature: number; lastFreshDataMs: number };
  nowMs: number;
} => {
  const { device, nowMs } = params;
  // A finite `currentTemperature` paired with a finite `lastFreshDataMs` is
  // proof the device has produced at least one trusted observation. That is
  // the only gate this resolver needs: aged-out readings are still useful
  // because thermostats fall silent at setpoint, but a device that never
  // reported anything has no value to credit.
  if (typeof device.currentTemperature !== 'number' || !Number.isFinite(device.currentTemperature)) return false;
  if (
    typeof device.lastFreshDataMs !== 'number'
    || !Number.isFinite(device.lastFreshDataMs)
    || device.lastFreshDataMs <= 0
  ) return false;
  // Future-skew guard catches clock errors. No age-based gate: a thermostat
  // that hasn't reported in hours is most likely simply at setpoint.
  return device.lastFreshDataMs <= nowMs + OBJECTIVE_PROFILE_MAX_FUTURE_SKEW_MS;
};

export const resolveObjectiveProgress = (params: {
  objective: DeferredObjectiveSettingsEntry;
  device: ObjectiveDeviceInput;
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
  if (!hasUsableTemperatureProgress({ device, nowMs })) {
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
  const usableTemperatureC = Number(device.currentTemperature);
  return {
    remainingUnits: Math.max(0, objective.targetTemperatureC - usableTemperatureC),
    currentPercent: null,
    currentTemperatureC: usableTemperatureC,
    reasonCode: null,
  };
};
