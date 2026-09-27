import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { getSteppedLoadStep, isSteppedLoadOffStep } from '../../packages/shared-domain/src/deviceControlProfiles';

/**
 * Step-axis "is this device parked at its off step?" — eligibility-free, kind-free.
 * For a step-only stepper (no binary handle, so no `currentOn`), this is the
 * authoritative off-state. Returns false when there is no profile or no resolved
 * step (the step axis can't answer), so callers treat "unknown step" as not-off.
 */
export const isSteppedDeviceAtOffStep = (
  device: { steppedLoadProfile?: SteppedLoadProfile; selectedStepId?: string },
): boolean => {
  const { steppedLoadProfile: profile, selectedStepId } = device;
  if (!profile || selectedStepId === undefined) return false;
  const step = getSteppedLoadStep(profile, selectedStepId);
  return step ? isSteppedLoadOffStep(profile, step.id) : false;
};

/**
 * Step-axis "is this device parked at an ACTIVE step?" — the exact mirror of
 * {@link isSteppedDeviceAtOffStep}. An unknown/invalid step answers false to
 * BOTH (the step axis can't decide — old `isObservedOn`/`isObservedOff` returned
 * neither), so the two partition cleanly: off / active / unknown.
 */
export const isSteppedDeviceAtActiveStep = (
  device: { steppedLoadProfile?: SteppedLoadProfile; selectedStepId?: string },
): boolean => {
  const { steppedLoadProfile: profile, selectedStepId } = device;
  if (!profile || selectedStepId === undefined) return false;
  const step = getSteppedLoadStep(profile, selectedStepId);
  return step ? !isSteppedLoadOffStep(profile, step.id) : false;
};
