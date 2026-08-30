import type {
  DeviceControlProfile,
  DeviceControlProfiles,
  SteppedLoadProfile,
  SteppedLoadStep,
} from '../../packages/contracts/src/types';
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

export const getSteppedLoadHighestStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => {
  // ES2020-safe last-element access (no Array#at): this file rides into the
  // settings-ui tsc program (ES2020 lib) via the appTypeGuards import chain.
  const sorted = sortSteppedLoadSteps(profile.steps);
  return sorted[sorted.length - 1] ?? null;
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
  const [firstStep] = sortSteppedLoadSteps(profile.steps);
  return firstStep ?? null;
};

export const getSteppedLoadOffStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => (
  sortSteppedLoadSteps(profile.steps).find((step) => isSteppedLoadOffStep(profile, step.id))
    ?? null
);

/**
 * The off rule, in one place: a step is off when it draws nothing OR when it is
 * named `off`. `isSteppedLoadOffStep` and `hasUsableSteppedLoadLadder` are exact
 * opposites over a single step — see the mirrored copy in
 * `packages/contracts/src/deviceControlProfiles.ts` for why they must share it.
 */
const isOffStep = (step: SteppedLoadStep): boolean => step.planningPowerW <= 0 || step.id === 'off';

export const isSteppedLoadOffStep = (profile: SteppedLoadProfile, stepId?: string): boolean => {
  const step = getSteppedLoadStep(profile, stepId);
  if (!step) return false;
  return isOffStep(step);
};

/**
 * Whether a ladder can actually run the device: at least one rung that is not
 * an off step. The admission test for calling anything a stepped load — see the
 * docblock on the mirrored copy in
 * `packages/contracts/src/deviceControlProfiles.ts`.
 */
export const hasUsableSteppedLoadLadder = (
  profile: Pick<SteppedLoadProfile, 'steps'> | null | undefined,
): boolean => profile?.steps.some((step) => !isOffStep(step)) === true;

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

/**
 * THE parse boundary for a persisted/untrusted stepped profile — mirrored from
 * `packages/contracts/src/deviceControlProfiles.ts`; read that docblock for the
 * full reasoning.
 *
 * Short version: `steps` is the test, plus one negative check on a field the TYPE
 * does not have. `SteppedLoadProfile` carries no `model` tag, but this function
 * takes `unknown` and owes a complete classification of what is actually there:
 * an absent tag and a legacy `'stepped_load'` are both accepted (so old records
 * parse identically to new ones), while a PRESENT FOREIGN value is rejected even
 * with a good ladder — an external writer can PUT into this setting, and a
 * foreign-tagged entry that parsed here would lose its tag to the repair rewrite
 * and go on to drive stepped commands. A future SECOND profile type reads its
 * discriminator HERE, at the `unknown` boundary, not downstream.
 */
export const normalizeSteppedLoadProfile = (
  value: unknown,
): SteppedLoadProfile | null => {
  if (!value || typeof value !== 'object') return null;
  // `model` is deliberately NOT on `SteppedLoadProfile` — see the docblock. The
  // cast widens to read it anyway, which is exactly what a boundary taking
  // `unknown` is for: absent or the legacy `'stepped_load'` passes, a foreign tag
  // is refused rather than silently laundered into a trusted stepped profile.
  const profile = value as Partial<SteppedLoadProfile> & { model?: unknown };
  if (profile.model !== undefined && profile.model !== 'stepped_load') return null;
  if (!Array.isArray(profile.steps)) return null;

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

  if (!hasUsableSteppedLoadLadder({ steps })) return null;
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id)) return null;
    stepIds.add(step.id);
  }

  return {
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
