import type { DeferredObjectiveSettingsEntry } from '../../../contracts/src/deferredObjectiveSettings.ts';
import { getSteppedLoadLowestActiveStep } from '../../../contracts/src/deviceControlProfiles.ts';
import type { DeviceObjectiveProfile } from '../../../contracts/src/objectiveProfileTypes.ts';
import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import type { DeferredObjectiveActivePlanV1 } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { isFiniteNumber } from './deadlinePlanData.ts';

export const resolveUsefulPowerKw = (device: TargetDeviceSnapshot): number | null => {
  const candidates = [
    device.planningPowerKw,
    device.expectedPowerKw,
    device.powerKw,
    device.loadKw,
  ];
  const value = candidates.find((candidate) => isFiniteNumber(candidate) && candidate > 0);
  if (value) return value;
  const steps = device.steppedLoadProfile?.steps ?? [];
  const highestStepPowerW = Math.max(
    0,
    ...steps.map((step) => (
      isFiniteNumber(step.planningPowerW) ? step.planningPowerW : 0
    )),
  );
  return highestStepPowerW > 0 ? highestStepPowerW / 1000 : null;
};

// The planner commits to running this device at the lowest non-zero step for
// the full hour (see `resolveAllocation` in `lib/plan/deferredObjectives/
// horizonPlanner.ts`). The Plan inputs card surfaces that committed power so
// the user can sanity-check "Needs X kWh" against the realistic per-hour cap.
export const resolveLowestActiveStepKw = (device: TargetDeviceSnapshot): number | null => {
  const profile = device.steppedLoadProfile;
  if (profile) {
    const lowestActiveStep = getSteppedLoadLowestActiveStep(profile);
    if (lowestActiveStep && isFiniteNumber(lowestActiveStep.planningPowerW) && lowestActiveStep.planningPowerW > 0) {
      return lowestActiveStep.planningPowerW / 1000;
    }
  }
  return isFiniteNumber(device.planningPowerKw) && device.planningPowerKw > 0
    ? device.planningPowerKw
    : null;
};

const resolveProfileSampleValue = (
  profile: DeviceObjectiveProfile | null,
  unit: DeviceObjectiveProfile['lastSample']['unit'],
): number | null => {
  if (!profile || profile.lastSample.unit !== unit) return null;
  return isFiniteNumber(profile.lastSample.value) ? profile.lastSample.value : null;
};

export type DeadlineProgress = {
  currentValue: number;
  remainingUnits: number;
  targetValue: number;
  unit: '°C' | '%';
};

export const resolveProgress = (params: {
  device: TargetDeviceSnapshot;
  objective: DeferredObjectiveSettingsEntry;
  profile: DeviceObjectiveProfile | null;
}): DeadlineProgress | null => {
  const { device, objective, profile } = params;
  if (objective.kind === 'temperature') {
    const currentTemperature = isFiniteNumber(device.currentTemperature)
      ? device.currentTemperature
      : resolveProfileSampleValue(profile, 'degree_c');
    if (!isFiniteNumber(currentTemperature)) return null;
    const remainingUnits = Math.max(0, objective.targetTemperatureC - currentTemperature);
    return {
      currentValue: currentTemperature,
      remainingUnits,
      targetValue: objective.targetTemperatureC,
      unit: '°C',
    };
  }

  const percent = isFiniteNumber(device.stateOfCharge?.percent)
    ? device.stateOfCharge.percent
    : resolveProfileSampleValue(profile, 'percent');
  if (!isFiniteNumber(percent)) return null;
  return {
    currentValue: Math.min(100, Math.max(0, percent)),
    remainingUnits: Math.max(0, objective.targetPercent - percent),
    targetValue: objective.targetPercent,
    unit: '%',
  };
};

export const resolveProfile = (
  powerTracker: PowerTrackerState | null,
  deviceId: string,
  objectiveKind: DeferredObjectiveSettingsEntry['kind'],
): DeviceObjectiveProfile | null => {
  const profile = powerTracker?.objectiveProfiles?.[deviceId];
  return profile?.kind === objectiveKind ? profile : null;
};

const sumAllocationKWh = (activePlan: DeferredObjectiveActivePlanV1): number | null => {
  const hours = activePlan.latest?.hours;
  if (!hours) return null;
  let total = 0;
  for (const hour of hours) {
    if (isFiniteNumber(hour.plannedKWh) && hour.plannedKWh > 0) total += hour.plannedKWh;
  }
  return total;
};

export const resolveEnergyNeededKWh = (params: {
  profile: DeviceObjectiveProfile | null;
  remainingUnits: number;
  activePlan: DeferredObjectiveActivePlanV1;
}): { energyNeededKWh: number; confidence: string | null } | null => {
  // Allocation from the recorder is authoritative: the planner already sized
  // the kWh against whatever data it had, so the UI must not refuse to render
  // just because its own learned profile is missing. The sum spans every
  // allocated hour (including past hours), matching the timeline chart, which
  // iterates the same set and accumulates planned kWh against `progressPerKWh`.
  const allocated = sumAllocationKWh(params.activePlan);
  if (allocated !== null && allocated > 0) {
    return { energyNeededKWh: allocated, confidence: params.profile?.kwhPerUnit?.confidence ?? null };
  }
  const stat = params.profile?.kwhPerUnit;
  if (!stat || !isFiniteNumber(stat.mean) || stat.mean <= 0) return null;
  return { energyNeededKWh: params.remainingUnits * stat.mean, confidence: stat.confidence };
};
