import { clamp } from '../utils/mathUtils';
import { CONTROLLED_USAGE_WEIGHT } from './dailyBudgetConstants';
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
    profileSplitSampleCount: typeof state.profileSplitSampleCount === 'number'
      ? state.profileSplitSampleCount
      : 0,
  };
};

const resolveProfileUncontrolled = (
  state: DailyBudgetState,
  defaultProfile: number[],
): DailyBudgetProfile => (isValidProfile(state.profileUncontrolled)
  ? state.profileUncontrolled
  : buildFallbackProfile(defaultProfile));

const resolveProfileControlled = (
  state: DailyBudgetState,
  defaultProfile: number[],
): DailyBudgetProfile => (isValidProfile(state.profileControlled)
  ? state.profileControlled
  : buildFallbackProfile(defaultProfile));

const resolveControlledShare = (state: DailyBudgetState): number => (
  typeof state.profileControlledShare === 'number' ? state.profileControlledShare : 0
);

const resolveSampleCount = (state: DailyBudgetState): number => {
  if (typeof state.profileSampleCount === 'number') return state.profileSampleCount;
  if (typeof state.profileUncontrolled?.sampleCount === 'number') return state.profileUncontrolled.sampleCount;
  return state.profile?.sampleCount ?? 0;
};

const resolveSplitSampleCount = (state: DailyBudgetState): number => (
  typeof state.profileSplitSampleCount === 'number' ? state.profileSplitSampleCount : 0
);

const hasProfileChanges = (
  state: DailyBudgetState,
  next: {
    profileUncontrolled: DailyBudgetProfile;
    profileControlled: DailyBudgetProfile;
    controlledShare: number;
    sampleCount: number;
    splitSampleCount: number;
  },
): boolean => (
  next.profileUncontrolled !== state.profileUncontrolled
  || next.profileControlled !== state.profileControlled
  || next.controlledShare !== state.profileControlledShare
  || next.sampleCount !== state.profileSampleCount
  || next.splitSampleCount !== state.profileSplitSampleCount
);

export const ensureDailyBudgetProfile = (
  state: DailyBudgetState,
  defaultProfile: number[],
): { state: DailyBudgetState; changed: boolean } => {
  const migrated = migrateLegacyProfile(state, defaultProfile);
  if (migrated) {
    return { state: migrated, changed: true };
  }

  const next = {
    profileUncontrolled: resolveProfileUncontrolled(state, defaultProfile),
    profileControlled: resolveProfileControlled(state, defaultProfile),
    controlledShare: resolveControlledShare(state),
    sampleCount: resolveSampleCount(state),
    splitSampleCount: resolveSplitSampleCount(state),
  };

  if (!hasProfileChanges(state, next)) return { state, changed: false };
  return {
    state: {
      ...state,
      profileUncontrolled: next.profileUncontrolled,
      profileControlled: next.profileControlled,
      profileControlledShare: next.controlledShare,
      profileSampleCount: next.sampleCount,
      profileSplitSampleCount: next.splitSampleCount,
    },
    changed: true,
  };
};

export const getProfileSampleCount = (state: DailyBudgetState): number => resolveSampleCount(state);

export const getProfileSplitSampleCount = (state: DailyBudgetState): number => resolveSplitSampleCount(state);

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
  const weight = clampShare(settings.controlledUsageWeight ?? CONTROLLED_USAGE_WEIGHT);
  const denom = (1 - controlledShare) + controlledShare * weight;
  if (!Number.isFinite(denom) || denom <= 0) {
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
  profileMeta: { sampleCount: number; splitSampleCount: number; controlledShare: number };
} => {
  const profileData = getEffectiveProfileData(state, settings, defaultProfile);
  const learned = getLearnedProfileParts(state, settings, defaultProfile);
  const splitSampleCount = typeof state.profileSplitSampleCount === 'number' ? state.profileSplitSampleCount : 0;
  return {
    combinedWeights: profileData.combinedWeights,
    learnedWeights: learned?.combined ?? null,
    profileMeta: {
      sampleCount: profileData.sampleCount,
      splitSampleCount,
      controlledShare: profileData.controlledShare,
    },
  };
};
