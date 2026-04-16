import type { DeviceControlProfile, DeviceControlProfiles, SteppedLoadProfile, SteppedLoadStep } from './types';

export const POWER_HEURISTIC_ABSOLUTE_TOLERANCE_W = 350;
export const POWER_HEURISTIC_RATIO_TOLERANCE = 0.35;

// Keep these step-selection helpers mirrored with
// packages/contracts/src/deviceControlProfiles.ts. The runtime/Jest/Homey
// path cannot safely import that ESM contracts module directly.
export const sortSteppedLoadSteps = (steps: SteppedLoadStep[]): SteppedLoadStep[] => (
  [...steps].sort((left, right) => left.planningPowerW - right.planningPowerW || left.id.localeCompare(right.id))
);

export const getSteppedLoadStep = (
  profile: SteppedLoadProfile,
  stepId?: string,
): SteppedLoadStep | null => {
  if (!stepId) return null;
  return profile.steps.find((step) => step.id === stepId) ?? null;
};

export const getSteppedLoadHighestStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => (
  sortSteppedLoadSteps(profile.steps).at(-1) ?? null
);

export const getSteppedLoadLowestActiveStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => (
  sortSteppedLoadSteps(profile.steps).find((step) => step.planningPowerW > 0)
    ?? null
);

export const getSteppedLoadRestoreStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => (
  getSteppedLoadLowestActiveStep(profile)
    ?? getSteppedLoadHighestStep(profile)
);

export const getSteppedLoadLowestStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => {
  const [firstStep] = sortSteppedLoadSteps(profile.steps);
  return firstStep ?? null;
};

export const getSteppedLoadOffStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => (
  sortSteppedLoadSteps(profile.steps).find((step) => isSteppedLoadOffStep(profile, step.id))
    ?? null
);

export const isSteppedLoadOffStep = (profile: SteppedLoadProfile, stepId?: string): boolean => {
  const step = getSteppedLoadStep(profile, stepId);
  if (!step) return false;
  return step.planningPowerW <= 0 || step.id === 'off';
};

export const resolveSteppedLoadPlanningPowerKw = (
  profile: SteppedLoadProfile,
  stepId?: string,
): number | undefined => {
  const step = getSteppedLoadStep(profile, stepId);
  if (!step) return undefined;
  return step.planningPowerW / 1000;
};

export const getSteppedLoadNextHigherStep = (params: {
  profile: SteppedLoadProfile;
  stepId?: string;
  ceilingStepId?: string;
}): SteppedLoadStep | null => {
  const { profile, stepId, ceilingStepId } = params;
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  const currentStep = getSteppedLoadStep(profile, stepId)
    ?? getSteppedLoadRestoreStep(profile)
    ?? sortedSteps[0]
    ?? null;
  if (!currentStep) return null;
  const currentIndex = sortedSteps.findIndex((step) => step.id === currentStep.id);
  if (currentIndex < 0) return null;
  const ceilingIndex = ceilingStepId
    ? sortedSteps.findIndex((step) => step.id === ceilingStepId)
    : Number.POSITIVE_INFINITY;
  for (let index = currentIndex + 1; index < sortedSteps.length; index += 1) {
    if (index > ceilingIndex) break;
    return sortedSteps[index] ?? null;
  }
  return null;
};

export const getSteppedLoadNextLowerStep = (params: {
  profile: SteppedLoadProfile;
  stepId?: string;
  floorStepId?: string;
}): SteppedLoadStep | null => {
  const { profile, stepId, floorStepId } = params;
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  const currentStep = getSteppedLoadStep(profile, stepId)
    ?? getSteppedLoadRestoreStep(profile)
    ?? sortedSteps[0]
    ?? null;
  if (!currentStep) return null;
  const currentIndex = sortedSteps.findIndex((step) => step.id === currentStep.id);
  if (currentIndex < 0) return null;
  const floorIndex = floorStepId ? sortedSteps.findIndex((step) => step.id === floorStepId) : Number.NEGATIVE_INFINITY;
  if (floorStepId && floorIndex < 0) return null;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (index < floorIndex) break;
    return sortedSteps[index] ?? null;
  }
  return null;
};

export const resolveSteppedLoadPowerHeuristicStepId = (
  profile: SteppedLoadProfile,
  measuredPowerKw?: number,
): string | undefined => {
  if (typeof measuredPowerKw !== 'number' || !Number.isFinite(measuredPowerKw) || measuredPowerKw <= 0) {
    return undefined;
  }
  const measuredPowerW = measuredPowerKw * 1000;
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  let bestStep: SteppedLoadStep | null = null;
  let bestDeltaW = Number.POSITIVE_INFINITY;
  for (const step of sortedSteps) {
    if (step.planningPowerW <= 0) continue;
    const deltaW = Math.abs(step.planningPowerW - measuredPowerW);
    if (deltaW < bestDeltaW) {
      bestDeltaW = deltaW;
      bestStep = step;
    }
  }
  if (!bestStep) return undefined;
  const toleranceW = Math.max(
    POWER_HEURISTIC_ABSOLUTE_TOLERANCE_W,
    bestStep.planningPowerW * POWER_HEURISTIC_RATIO_TOLERANCE,
  );
  return bestDeltaW <= toleranceW ? bestStep.id : undefined;
};

export const normalizeSteppedLoadProfile = (
  value: unknown,
): SteppedLoadProfile | null => {
  if (!value || typeof value !== 'object') return null;
  const profile = value as Partial<SteppedLoadProfile>;
  if (profile.model !== 'stepped_load' || !Array.isArray(profile.steps)) return null;

  const steps: SteppedLoadStep[] = profile.steps
    .map((step): SteppedLoadStep | null => {
      if (!step || typeof step !== 'object') return null;
      const next = step as Partial<SteppedLoadStep> & { label?: unknown; order?: unknown };
      if (typeof next.id !== 'string' || next.id.trim() === '') return null;
      if (typeof next.planningPowerW !== 'number' || !Number.isFinite(next.planningPowerW) || next.planningPowerW < 0) {
        return null;
      }
      return {
        id: next.id.trim(),
        planningPowerW: next.planningPowerW,
      };
    })
    .filter((step): step is SteppedLoadStep => step !== null);

  if (steps.length === 0) return null;
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id)) return null;
    stepIds.add(step.id);
  }

  return {
    model: 'stepped_load',
    steps: sortSteppedLoadSteps(steps),
    ...(typeof profile.tankVolumeL === 'number' && Number.isFinite(profile.tankVolumeL)
      ? { tankVolumeL: profile.tankVolumeL }
      : {}),
    ...(typeof profile.minComfortTempC === 'number' && Number.isFinite(profile.minComfortTempC)
      ? { minComfortTempC: profile.minComfortTempC }
      : {}),
    ...(typeof profile.maxStorageTempC === 'number' && Number.isFinite(profile.maxStorageTempC)
      ? { maxStorageTempC: profile.maxStorageTempC }
      : {}),
  };
};

export const normalizeDeviceControlProfile = (value: unknown): DeviceControlProfile | null => {
  const steppedLoadProfile = normalizeSteppedLoadProfile(value);
  if (steppedLoadProfile) return steppedLoadProfile;
  return null;
};

export const normalizeDeviceControlProfiles = (
  value: unknown,
): DeviceControlProfiles | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value).flatMap(([deviceId, profileValue]) => {
      if (!deviceId.trim()) return [];
      const profile = normalizeDeviceControlProfile(profileValue);
      return profile ? [[deviceId, profile]] : [];
    }),
  );
};
