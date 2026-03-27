import type {
  DeviceControlProfile,
  DeviceControlProfiles,
  DeviceControlModel,
  SteppedLoadActualStepSource,
  SteppedLoadProfile,
  SteppedLoadStep,
} from './types.js';

const POWER_HEURISTIC_ABSOLUTE_TOLERANCE_W = 350;
const POWER_HEURISTIC_RATIO_TOLERANCE = 0.35;

export const DEFAULT_DEVICE_CONTROL_MODEL: DeviceControlModel = 'temperature_target';

export const sortSteppedLoadSteps = (steps: SteppedLoadStep[]): SteppedLoadStep[] => (
  steps.slice().sort((a, b) => a.planningPowerW - b.planningPowerW || a.id.localeCompare(b.id))
);

export const getSteppedLoadStep = (
  profile: SteppedLoadProfile,
  stepId?: string | null,
): SteppedLoadStep | null => {
  if (!stepId) return null;
  return profile.steps.find((step) => step.id === stepId) ?? null;
};

export const getSteppedLoadHighestStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => {
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  return sortedSteps[sortedSteps.length - 1] ?? null;
};

export const getSteppedLoadLowestActiveStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => (
  sortSteppedLoadSteps(profile.steps).find((step) => step.planningPowerW > 0)
    ?? null
);

export const getSteppedLoadRestoreStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => (
  getSteppedLoadLowestActiveStep(profile)
    ?? getSteppedLoadHighestStep(profile)
);

export const getSteppedLoadLowestStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => {
  const [lowest] = sortSteppedLoadSteps(profile.steps);
  return lowest ?? null;
};

export const getSteppedLoadOffStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => (
  sortSteppedLoadSteps(profile.steps).find((step) => isSteppedLoadOffStep(profile, step.id))
    ?? null
);

export const isSteppedLoadOffStep = (profile: SteppedLoadProfile, stepId?: string | null): boolean => {
  const step = getSteppedLoadStep(profile, stepId);
  if (!step) return false;
  return step.planningPowerW <= 0 || step.id === 'off';
};

export const resolveSteppedLoadPlanningPowerKw = (
  profile: SteppedLoadProfile,
  stepId?: string | null,
): number | undefined => {
  const step = getSteppedLoadStep(profile, stepId);
  if (!step) return undefined;
  return step.planningPowerW / 1000;
};

export const getSteppedLoadNextLowerStep = (params: {
  profile: SteppedLoadProfile;
  stepId?: string | null;
  floorStepId?: string | null;
}): SteppedLoadStep | null => {
  const { profile, stepId, floorStepId } = params;
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  const current = getSteppedLoadStep(profile, stepId) ?? getSteppedLoadHighestStep(profile);
  if (!current) return null;
  const currentIndex = sortedSteps.findIndex((step) => step.id === current.id);
  if (currentIndex <= 0) return null;
  const floorIndex = floorStepId
    ? sortedSteps.findIndex((step) => step.id === floorStepId)
    : -1;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (index < floorIndex) break;
    return sortedSteps[index] ?? null;
  }
  return null;
};

export const getSteppedLoadNextHigherStep = (params: {
  profile: SteppedLoadProfile;
  stepId?: string | null;
  ceilingStepId?: string | null;
}): SteppedLoadStep | null => {
  const { profile, stepId, ceilingStepId } = params;
  const sortedSteps = sortSteppedLoadSteps(profile.steps);
  const current = getSteppedLoadStep(profile, stepId) ?? getSteppedLoadRestoreStep(profile);
  if (!current) return null;
  const currentIndex = sortedSteps.findIndex((step) => step.id === current.id);
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

export const resolveSteppedLoadPowerHeuristicStepId = (
  profile: SteppedLoadProfile,
  measuredPowerKw?: number,
): string | undefined => {
  if (typeof measuredPowerKw !== 'number' || !Number.isFinite(measuredPowerKw) || measuredPowerKw <= 0) {
    return undefined;
  }
  const measuredPowerW = measuredPowerKw * 1000;
  let bestStep: SteppedLoadStep | null = null;
  let bestDeltaW = Number.POSITIVE_INFINITY;
  for (const step of profile.steps) {
    if (step.planningPowerW <= 0) continue;
    const deltaW = Math.abs(step.planningPowerW - measuredPowerW);
    if (deltaW < bestDeltaW) {
      bestStep = step;
      bestDeltaW = deltaW;
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

export const normalizeDeviceControlProfile = (
  value: unknown,
): DeviceControlProfile | null => {
  return normalizeSteppedLoadProfile(value);
};

export const normalizeDeviceControlProfiles = (
  value: unknown,
): DeviceControlProfiles => {
  if (!value || typeof value !== 'object') return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([deviceId, profile]) => {
      const normalized = normalizeDeviceControlProfile(profile);
      return normalized ? [deviceId, normalized] as const : null;
    })
    .filter((entry): entry is readonly [string, DeviceControlProfile] => entry !== null);
  return Object.fromEntries(entries);
};

export const resolveSteppedLoadSelectedStepSource = (params: {
  actualStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  assumedStepId?: string;
}): SteppedLoadActualStepSource | undefined => {
  const { actualStepId, actualStepSource, assumedStepId } = params;
  if (actualStepId) return actualStepSource;
  if (assumedStepId) return 'assumed';
  return undefined;
};
