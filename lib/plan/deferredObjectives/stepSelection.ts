import type { DeferredObjectiveStep } from './types';

export const normalizeObjectiveSteps = (
  steps: DeferredObjectiveStep[],
): DeferredObjectiveStep[] => (
  steps
    .filter((step) => (
      typeof step.id === 'string'
      && step.id.trim() !== ''
      && Number.isFinite(step.usefulPowerKw)
      && step.usefulPowerKw >= 0
    ))
    .map((step) => ({
      id: step.id.trim(),
      usefulPowerKw: step.usefulPowerKw,
    }))
    .sort((left, right) => left.usefulPowerKw - right.usefulPowerKw || left.id.localeCompare(right.id))
);

export const getActiveObjectiveSteps = (
  steps: DeferredObjectiveStep[],
): DeferredObjectiveStep[] => (
  steps.filter((step) => step.usefulPowerKw > 0)
);

export const selectMinimumStepForEnergy = (params: {
  steps: DeferredObjectiveStep[];
  energyKWh: number;
  durationHours: number;
  epsilonKWh: number;
}): DeferredObjectiveStep | null => {
  const {
    steps,
    energyKWh,
    durationHours,
    epsilonKWh,
  } = params;
  if (energyKWh <= epsilonKWh || durationHours <= 0) return null;
  const activeSteps = getActiveObjectiveSteps(steps);
  for (const step of activeSteps) {
    if ((step.usefulPowerKw * durationHours) + epsilonKWh >= energyKWh) {
      return step;
    }
  }
  return activeSteps.at(-1) ?? null;
};
