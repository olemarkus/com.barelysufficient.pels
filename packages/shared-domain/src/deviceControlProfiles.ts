import type {
  DeviceControlProfile,
  DeviceControlProfiles,
  SteppedLoadProfile,
  SteppedLoadStep,
} from '../../contracts/src/types';

// The one owner of the stepped-load ladder: step lookup, ordering, the off rule
// and the parse boundary for the persisted `device_control_profiles` map. The
// runtime (planner, executor, device transport) and the settings UI both read a
// ladder through it, so they cannot disagree on which step is off or which one a
// device restores to.
export const sortSteppedLoadSteps = (steps: SteppedLoadStep[]): SteppedLoadStep[] => (
  [...steps].sort((left, right) => left.planningPowerW - right.planningPowerW || left.id.localeCompare(right.id))
);

export const getSteppedLoadStep = (
  profile: SteppedLoadProfile,
  stepId?: string | null,
): SteppedLoadStep | null => {
  if (!stepId) return null;
  return profile.steps.find((step) => step.id === stepId) ?? null;
};

export const getSteppedLoadHighestStep = (profile: SteppedLoadProfile): SteppedLoadStep | null => {
  // ES2020-safe last-element access (no Array#at): shared-domain is bundled into
  // the settings UI, which esbuild targets at es2020.
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
 * named `off`, because the id is reserved and read as off on sight.
 *
 * `isSteppedLoadOffStep` and `hasUsableSteppedLoadLadder` are exact opposites
 * over a single step and must stay that way. Spelling the rule twice let a row
 * named `off` carrying positive power satisfy both at once: usable enough to
 * admit the profile, off enough that restoring to it never resumes the device.
 */
export const isSteppedLoadStepOff = (step: SteppedLoadStep): boolean => (
  step.planningPowerW <= 0 || step.id === 'off'
);

export const isSteppedLoadOffStep = (profile: SteppedLoadProfile, stepId?: string | null): boolean => {
  const step = getSteppedLoadStep(profile, stepId);
  if (!step) return false;
  return isSteppedLoadStepOff(step);
};

/**
 * Whether a ladder can actually run the device: at least one rung that is not
 * an off step.
 *
 * A ladder of nothing, or of nothing but off steps, is not a weaker stepped
 * profile — it is no stepped control at all. PELS could pause such a device but
 * never resume it, and every consumer that asks the ladder where to put the
 * device (`getSteppedLoadLowestActiveStep`, restore sizing, calibration) gets
 * `null` back and has to invent an answer. So this is the admission test for
 * calling anything a stepped load: the normalizer below rejects a profile that
 * fails it, and the producers refuse to classify a device as stepped without
 * it.
 */
export const hasUsableSteppedLoadLadder = (
  profile: Pick<SteppedLoadProfile, 'steps'> | null | undefined,
): boolean => profile?.steps.some((step) => !isSteppedLoadStepOff(step)) === true;

export const resolveSteppedLoadPlanningPowerKw = (
  profile: SteppedLoadProfile,
  stepId?: string | null,
): number | undefined => {
  const step = getSteppedLoadStep(profile, stepId);
  if (!step) return undefined;
  return step.planningPowerW / 1000;
};

/**
 * THE parse boundary for a persisted/untrusted stepped profile: `unknown` in, a
 * typed `SteppedLoadProfile` or `null` out.
 *
 * "Is this blob a stepped profile?" is answered by `steps` — a valid array of
 * valid rungs with a usable ladder — plus one negative check on a field the TYPE
 * does not have.
 *
 * `SteppedLoadProfile` carries no `model` tag: `DeviceControlProfile` is a union
 * of one, so a tag would discriminate nothing, and every comparison against it on
 * an already-typed value was a presence check in costume. But THIS function takes
 * `value: unknown`, and a boundary owes its callers a COMPLETE classification of
 * what is actually there — including a tag that contradicts the slot it was
 * written into. So the asymmetry is deliberate:
 *
 * - `model` absent        → accepted (what PELS writes now)
 * - `model: 'stepped_load'` → accepted (what PELS wrote before the tag was deleted,
 *                             so old records parse identically to new ones)
 * - `model: <anything else>` → REJECTED, even with a perfectly good ladder
 *
 * The third case is not hypothetical. Homey's app-setting endpoint lets an
 * external writer PUT a JSON-encoded `device_control_profiles` map (see
 * `parseSettingRecord` in `setup/steppedProfileRepair.ts`), and a foreign-tagged
 * entry that parsed here would be rewritten WITHOUT its tag by the repair pass,
 * pass the boot guard, and then be selected as a device's effective stepped
 * profile by `resolveEffectiveSteppedLoadProfile` — i.e. a blob that announced it
 * was not a stepped load would end up issuing stepped commands. Refusing it costs
 * one comparison and keeps every downstream consumer tag-free.
 *
 * If a SECOND profile type is ever added, its discriminator is read HERE, at this
 * `unknown` boundary, where the question is genuinely open — never downstream on
 * values this function has already typed. See the docblock on
 * `SteppedLoadProfile` in `packages/contracts/src/types.ts`.
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

export const normalizeDeviceControlProfile = (value: unknown): DeviceControlProfile | null => (
  normalizeSteppedLoadProfile(value)
);

// `null` for a value that is not a device map at all (absent, an array, a
// scalar), so a caller can tell "no profiles" from "nothing readable". Entries
// with a blank device id or no usable profile are dropped.
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
