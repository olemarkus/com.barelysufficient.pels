import type { SteppedLoadProfile, SteppedLoadStep } from '../../packages/contracts/src/types';
import {
  getSteppedLoadRestoreStep,
  getSteppedLoadStep,
  sortSteppedLoadSteps,
} from '../../packages/shared-domain/src/deviceControlProfiles';

// Walking a stepped ladder one rung at a time, for the planner's step-up and
// step-down decisions (`lib/plan`) and the device's shed residual (`lib/device`).
// Runtime-only, so it lives here rather than beside the ladder itself in
// shared-domain, which holds what the settings UI reads too.

// The step a device at `stepId` moves to on its way up or down the ladder. An
// unknown `stepId` is read as the restore step (the lowest active one), where a
// device resting at no known step is headed anyway.
const resolveCurrentLadderIndex = (
  sortedSteps: SteppedLoadStep[],
  profile: SteppedLoadProfile,
  stepId: string | null | undefined,
): number => {
  const currentStep = getSteppedLoadStep(profile, stepId)
    ?? getSteppedLoadRestoreStep(profile)
    ?? sortedSteps[0]
    ?? null;
  if (!currentStep) return -1;
  return sortedSteps.findIndex((step) => step.id === currentStep.id);
};

export const getSteppedLoadNextHigherStep = (
  profile: SteppedLoadProfile,
  stepId?: string | null,
  ceilingStepId?: string | null,
): SteppedLoadStep | null => {
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  const currentIndex = resolveCurrentLadderIndex(sortedSteps, profile, stepId);
  if (currentIndex < 0) return null;
  const ceilingIndex = ceilingStepId
    ? sortedSteps.findIndex((step) => step.id === ceilingStepId)
    : Number.POSITIVE_INFINITY;
  const nextIndex = currentIndex + 1;
  if (nextIndex >= sortedSteps.length || nextIndex > ceilingIndex) return null;
  return sortedSteps[nextIndex] ?? null;
};

export const getSteppedLoadNextLowerStep = (
  profile: SteppedLoadProfile,
  stepId?: string | null,
  floorStepId?: string | null,
): SteppedLoadStep | null => {
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  const currentIndex = resolveCurrentLadderIndex(sortedSteps, profile, stepId);
  if (currentIndex < 0) return null;
  const floorIndex = floorStepId ? sortedSteps.findIndex((step) => step.id === floorStepId) : Number.NEGATIVE_INFINITY;
  if (floorStepId && floorIndex < 0) return null;
  const nextIndex = currentIndex - 1;
  if (nextIndex < 0 || nextIndex < floorIndex) return null;
  return sortedSteps[nextIndex] ?? null;
};
