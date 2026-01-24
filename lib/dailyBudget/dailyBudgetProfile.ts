import { clamp } from '../utils/mathUtils';
import { getConfidence, normalizeWeights } from './dailyBudgetMath';
import type { DailyBudgetProfile, DailyBudgetSettings, DailyBudgetState } from './dailyBudgetTypes';

type LearnedProfileParts = {
  uncontrolled: number[];
  controlled: number[];
  combined: number[];
  controlledShare: number;
  sampleCount: number;
};

const clampShare = (value: number): number => clamp(value, 0, 1);

const normalizeWithFallback = (weights: number[], fallback: number[]): number[] => {
  const normalized = normalizeWeights(weights);
  if (normalized.every((value) => value === 0)) return [...fallback];
  return normalized;
};

const buildFallbackProfile = (defaultProfile: number[]) => ({
  weights: [...defaultProfile],
  sampleCount: 0,
});

const isValidProfile = (profile?: DailyBudgetState['profile']): profile is DailyBudgetProfile => (
  Boolean(profile)
  && Array.isArray(profile?.weights)
  && profile.weights.length === 24
  && typeof profile.sampleCount === 'number'
);

const migrateLegacyProfile = (
  state: DailyBudgetState,
  defaultProfile: number[],
): DailyBudgetState | null => {
  if (state.profileUncontrolled || !state.profile) return null;
  return {
    ...state,
    profileUncontrolled: {
      weights: [...state.profile.weights],
      sampleCount: state.profile.sampleCount ?? 0,
    },
    profileControlled: isValidProfile(state.profileControlled)
      ? state.profileControlled
      : buildFallbackProfile(defaultProfile),
    profileControlledShare: typeof state.profileControlledShare === 'number' ? state.profileControlledShare : 0,
    profileSampleCount: typeof state.profileSampleCount === 'number'
      ? state.profileSampleCount
      : (state.profile.sampleCount ?? 0),
  };
};

export const ensureDailyBudgetProfile = (
  state: DailyBudgetState,
  defaultProfile: number[],
): { state: DailyBudgetState; changed: boolean } => {
  const migrated = migrateLegacyProfile(state, defaultProfile);
  if (migrated) {
    return { state: migrated, changed: true };
  }

  const nextProfileUncontrolled = isValidProfile(state.profileUncontrolled)
    ? state.profileUncontrolled
    : buildFallbackProfile(defaultProfile);
  const nextProfileControlled = isValidProfile(state.profileControlled)
    ? state.profileControlled
    : buildFallbackProfile(defaultProfile);
  const nextControlledShare = typeof state.profileControlledShare === 'number' ? state.profileControlledShare : 0;
  const nextSampleCount = typeof state.profileSampleCount === 'number'
    ? state.profileSampleCount
    : (nextProfileUncontrolled.sampleCount ?? state.profile?.sampleCount ?? 0);

  const changed = (
    nextProfileUncontrolled !== state.profileUncontrolled
    || nextProfileControlled !== state.profileControlled
    || nextControlledShare !== state.profileControlledShare
    || nextSampleCount !== state.profileSampleCount
  );
  if (!changed) return { state, changed: false };
  return {
    state: {
      ...state,
      profileUncontrolled: nextProfileUncontrolled,
      profileControlled: nextProfileControlled,
      profileControlledShare: nextControlledShare,
      profileSampleCount: nextSampleCount,
    },
    changed: true,
  };
};

export const getProfileSampleCount = (state: DailyBudgetState): number => {
  if (typeof state.profileSampleCount === 'number') return state.profileSampleCount;
  if (typeof state.profileUncontrolled?.sampleCount === 'number') return state.profileUncontrolled.sampleCount;
  return state.profile?.sampleCount ?? 0;
};

const getLearnedProfileParts = (
  state: DailyBudgetState,
  settings: DailyBudgetSettings,
  defaultProfile: number[],
): LearnedProfileParts | null => {
  const uncontrolled = state.profileUncontrolled?.weights;
  const controlled = state.profileControlled?.weights;
  if (!uncontrolled || !controlled) return null;
  const normalizedUncontrolled = normalizeWithFallback(uncontrolled, defaultProfile);
  const normalizedControlled = normalizeWithFallback(controlled, defaultProfile);
  const controlledShare = clampShare(state.profileControlledShare ?? 0);
  const weight = clampShare(settings.controlledUsageWeight);
  const denom = (1 - controlledShare) + controlledShare * weight;
  if (denom <= 0) {
    return {
      uncontrolled: normalizedUncontrolled,
      controlled: normalizedControlled.map(() => 0),
      combined: normalizeWithFallback(normalizedUncontrolled, defaultProfile),
      controlledShare,
      sampleCount: getProfileSampleCount(state),
    };
  }
  const uncontrolledScale = (1 - controlledShare) / denom;
  const controlledScale = (controlledShare * weight) / denom;
  const learnedUncontrolled = normalizedUncontrolled.map((value) => value * uncontrolledScale);
  const learnedControlled = normalizedControlled.map((value) => value * controlledScale);
  const combined = normalizeWithFallback(
    learnedUncontrolled.map((value, index) => value + (learnedControlled[index] ?? 0)),
    defaultProfile,
  );
  return {
    uncontrolled: learnedUncontrolled,
    controlled: learnedControlled,
    combined,
    controlledShare,
    sampleCount: getProfileSampleCount(state),
  };
};

export const getEffectiveProfileData = (
  state: DailyBudgetState,
  settings: DailyBudgetSettings,
  defaultProfile: number[],
): {
  combinedWeights: number[];
  breakdown: { uncontrolled: number[]; controlled: number[] };
  sampleCount: number;
  controlledShare: number;
} => {
  const learned = getLearnedProfileParts(state, settings, defaultProfile);
  const confidence = getConfidence(getProfileSampleCount(state));
  if (!learned) {
    return {
      combinedWeights: [...defaultProfile],
      breakdown: {
        uncontrolled: [...defaultProfile],
        controlled: defaultProfile.map(() => 0),
      },
      sampleCount: 0,
      controlledShare: 0,
    };
  }
  const effectiveUncontrolled = defaultProfile.map((value, index) => (
    value * (1 - confidence) + (learned.uncontrolled[index] ?? 0) * confidence
  ));
  const effectiveControlled = learned.controlled.map((value) => value * confidence);
  const combinedWeights = normalizeWithFallback(
    effectiveUncontrolled.map((value, index) => value + (effectiveControlled[index] ?? 0)),
    defaultProfile,
  );
  return {
    combinedWeights,
    breakdown: {
      uncontrolled: effectiveUncontrolled,
      controlled: effectiveControlled,
    },
    sampleCount: learned.sampleCount,
    controlledShare: learned.controlledShare,
  };
};

export const getProfileDebugSummary = (
  state: DailyBudgetState,
  settings: DailyBudgetSettings,
  defaultProfile: number[],
): {
  combinedWeights: number[];
  learnedWeights: number[] | null;
  profileMeta: { sampleCount: number; controlledShare: number };
} => {
  const profileData = getEffectiveProfileData(state, settings, defaultProfile);
  const learned = getLearnedProfileParts(state, settings, defaultProfile);
  return {
    combinedWeights: profileData.combinedWeights,
    learnedWeights: learned?.combined ?? null,
    profileMeta: {
      sampleCount: profileData.sampleCount,
      controlledShare: profileData.controlledShare,
    },
  };
};
