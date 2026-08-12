import {
  getSteppedLoadHighestStep,
  getSteppedLoadLowestStep,
  getSteppedLoadNextHigherStep,
  getSteppedLoadNextLowerStep,
  getSteppedLoadOffStep,
  getSteppedLoadRestoreStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
  normalizeDeviceControlProfiles,
  normalizeSteppedLoadProfile,
  resolveSteppedLoadPlanningPowerKw,
  sortSteppedLoadSteps,
} from '../../lib/utils/deviceControlProfiles';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

const buildProfile = (): SteppedLoadProfile => ({
  steps: [
    { id: 'max', planningPowerW: 3000 },
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
  ],
});

describe('deviceControlProfiles', () => {
  it('sorts stepped-load steps and resolves common helper lookups', () => {
    const profile = buildProfile();
    const samePowerSteps = [
      { id: 'b', planningPowerW: 500 },
      { id: 'a', planningPowerW: 500 },
    ];

    expect(sortSteppedLoadSteps(profile.steps).map((step) => step.id)).toEqual(['off', 'low', 'max']);
    expect(sortSteppedLoadSteps(samePowerSteps).map((step) => step.id)).toEqual(['a', 'b']);
    expect(getSteppedLoadStep(profile, 'low')?.id).toBe('low');
    expect(getSteppedLoadStep(profile, 'missing')).toBeNull();
    expect(getSteppedLoadLowestStep(profile)?.id).toBe('off');
    expect(getSteppedLoadHighestStep(profile)?.id).toBe('max');
    expect(getSteppedLoadRestoreStep(profile)?.id).toBe('low');
    expect(getSteppedLoadOffStep(profile)?.id).toBe('off');
    expect(isSteppedLoadOffStep(profile, 'off')).toBe(true);
    expect(isSteppedLoadOffStep(profile, 'low')).toBe(false);
    expect(resolveSteppedLoadPlanningPowerKw(profile, 'max')).toBe(3);
    expect(resolveSteppedLoadPlanningPowerKw(profile, 'missing')).toBeUndefined();
  });

  it('resolves the next higher step using explicit and fallback start points', () => {
    const profile = buildProfile();
    const offOnlyProfile: SteppedLoadProfile = {
      steps: [{ id: 'idle', planningPowerW: 0 }],
    };
    const emptyProfile = { steps: [] } as unknown as SteppedLoadProfile;

    expect(getSteppedLoadNextHigherStep({ profile, stepId: 'off' })?.id).toBe('low');
    expect(getSteppedLoadNextHigherStep({ profile, stepId: 'low', ceilingStepId: 'max' })?.id).toBe('max');
    expect(getSteppedLoadNextHigherStep({ profile, stepId: 'max' })).toBeNull();
    expect(getSteppedLoadNextHigherStep({ profile, stepId: undefined })?.id).toBe('max');
    expect(getSteppedLoadRestoreStep(offOnlyProfile)?.id).toBe('idle');
    expect(getSteppedLoadOffStep(offOnlyProfile)?.id).toBe('idle');
    expect(isSteppedLoadOffStep(offOnlyProfile, 'idle')).toBe(true);
    expect(getSteppedLoadHighestStep(emptyProfile)).toBeNull();
    expect(getSteppedLoadLowestStep(emptyProfile)).toBeNull();
    expect(getSteppedLoadNextHigherStep({ profile: emptyProfile, stepId: undefined })).toBeNull();
  });

  it('resolves the next lower step using fallback start points and respects a valid floor', () => {
    const profile = buildProfile();
    const offOnlyProfile: SteppedLoadProfile = {
      steps: [{ id: 'idle', planningPowerW: 0 }],
    };

    expect(getSteppedLoadNextLowerStep({ profile, stepId: 'max' })?.id).toBe('low');
    expect(getSteppedLoadNextLowerStep({ profile, stepId: 'max', floorStepId: 'low' })?.id).toBe('low');
    expect(getSteppedLoadNextLowerStep({ profile, stepId: 'low', floorStepId: 'low' })).toBeNull();
    expect(getSteppedLoadNextLowerStep({ profile, stepId: undefined })?.id).toBe('off');
    expect(getSteppedLoadNextLowerStep({ profile, stepId: 'max', floorStepId: 'missing' })).toBeNull();
    expect(getSteppedLoadNextLowerStep({ profile: offOnlyProfile, stepId: undefined })).toBeNull();
  });

  it('normalizes valid stepped-load profiles and rejects invalid ones', () => {
    const valid = normalizeSteppedLoadProfile({
      steps: [
        { id: 'high', label: 'High', order: 2, planningPowerW: 2500 },
        { id: 'off', planningPowerW: 0 },
        { id: 'mid', label: 'Mid', order: 1, planningPowerW: 1500 },
      ],
      tankVolumeL: 300,
      minComfortTempC: 55,
      maxStorageTempC: 75,
    });
    const duplicateId = normalizeSteppedLoadProfile({
      steps: [
        { id: 'dup', planningPowerW: 0 },
        { id: 'dup', planningPowerW: 1000 },
      ],
    });
    const invalidPower = normalizeSteppedLoadProfile({
      steps: [
        { id: 'bad', planningPowerW: -1 },
      ],
    });

    expect(valid).toEqual({
      steps: [
        { id: 'off', planningPowerW: 0 },
        { id: 'mid', planningPowerW: 1500 },
        { id: 'high', planningPowerW: 2500 },
      ],
      tankVolumeL: 300,
      minComfortTempC: 55,
      maxStorageTempC: 75,
    });
    expect(duplicateId).toBeNull();
    expect(invalidPower).toBeNull();
    expect(normalizeSteppedLoadProfile(null)).toBeNull();
    expect(normalizeSteppedLoadProfile({})).toBeNull();
    expect(normalizeSteppedLoadProfile({ steps: {} })).toBeNull();
    expect(normalizeSteppedLoadProfile({
      steps: [null, { id: '', planningPowerW: 500 }],
    })).toBeNull();
    expect(normalizeSteppedLoadProfile({
      steps: [{ id: 'x', planningPowerW: 500 }],
    })).toEqual({
      steps: [{ id: 'x', planningPowerW: 500 }],
    });
  });

  // The `model` tag is gone from `SteppedLoadProfile`, but this boundary takes
  // `unknown`, so it still has to classify all three shapes an untrusted blob can
  // arrive in. Absent and legacy-tagged both parse to the same tag-free value;
  // a FOREIGN tag is refused rather than laundered into a trusted stepped profile
  // (see `rejects a profile whose model tag contradicts the slot` below for why
  // that third case is reachable).
  describe('model tag at the unknown boundary', () => {
    const ladder = [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 2000 }];

    it('accepts a profile with no model tag, and stores none', () => {
      const parsed = normalizeSteppedLoadProfile({ steps: ladder });

      expect(parsed).toEqual({ steps: ladder });
      expect(parsed).not.toHaveProperty('model');
    });

    it('accepts the legacy stepped_load tag and strips it', () => {
      // A profile persisted before the tag was deleted. It must parse to exactly
      // what a newly written one does, so no migration is needed on upgrade. The
      // rewritten value omits the tag, which is the one direction of this schema
      // change that is not backward-compatible: a downgrade to a build that still
      // gated on the tag would reject profiles saved after this change.
      const parsed = normalizeSteppedLoadProfile({ model: 'stepped_load', steps: ladder });

      expect(parsed).toEqual({ steps: ladder });
      expect(parsed).not.toHaveProperty('model');
    });

    it('rejects a profile whose model tag contradicts the slot, ladder or not', () => {
      // Reachable: Homey's app-setting endpoint lets an external writer PUT a
      // JSON-encoded `device_control_profiles` map. Accepting this would strip the
      // tag on the next repair rewrite and hand a blob that announced it was NOT a
      // stepped load to `resolveEffectiveSteppedLoadProfile`, which would then
      // issue stepped commands for that device.
      expect(normalizeSteppedLoadProfile({ model: 'binary_power', steps: ladder })).toBeNull();
      expect(normalizeSteppedLoadProfile({ model: 'temperature_target', steps: ladder })).toBeNull();
      // Not a string, and not a value we recognise: still not ours.
      expect(normalizeSteppedLoadProfile({ model: 7, steps: ladder })).toBeNull();
      expect(normalizeSteppedLoadProfile({ model: null, steps: ladder })).toBeNull();
    });

    it('drops only the foreign-tagged entry from a profile map', () => {
      expect(normalizeDeviceControlProfiles({
        'dev-untagged': { steps: ladder },
        'dev-legacy': { model: 'stepped_load', steps: ladder },
        'dev-foreign': { model: 'binary_power', steps: ladder },
      })).toEqual({
        'dev-untagged': { steps: ladder },
        'dev-legacy': { steps: ladder },
      });
    });
  });

  it('rejects a ladder with no step the device can run at', () => {
    // No steps at all, and a ladder of nothing but off, are the same thing:
    // stepped control PELS could pause but never resume. Neither is a weaker
    // profile to be salvaged — both are refused, and the device falls back to
    // its default control model.
    expect(normalizeSteppedLoadProfile({ steps: [] })).toBeNull();
    expect(normalizeSteppedLoadProfile({
      steps: [{ id: 'off', planningPowerW: 0 }],
    })).toBeNull();
    expect(normalizeSteppedLoadProfile({
      steps: [{ id: 'off', planningPowerW: 0 }, { id: 'idle', planningPowerW: 0 }],
    })).toBeNull();
  });

  it('rejects a ladder whose only powered rung is named off', () => {
    // `off` is a reserved id: `isSteppedLoadOffStep` reads it as off whatever
    // its watts say. A ladder standing only on such a rung would be admitted as
    // usable and then restored to a step the off-predicate calls off, so the
    // device could never resume — the two must agree, and here they do.
    const offNamedButPowered = {
      steps: [{ id: 'off', planningPowerW: 900 }],
    };

    expect(normalizeSteppedLoadProfile(offNamedButPowered)).toBeNull();
    expect(isSteppedLoadOffStep(offNamedButPowered as SteppedLoadProfile, 'off')).toBe(true);
    // A real rung alongside it is enough to make the profile usable again.
    expect(normalizeSteppedLoadProfile({
      steps: [{ id: 'off', planningPowerW: 900 }, { id: 'low', planningPowerW: 600 }],
    })).not.toBeNull();
  });

  it('drops only the unusable entries from a profile map, keeping the rest', () => {
    expect(normalizeDeviceControlProfiles({
      'dev-good': buildProfile(),
      'dev-empty': { steps: [] },
      'dev-off-only': { steps: [{ id: 'off', planningPowerW: 0 }] },
    })).toEqual({
      'dev-good': {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    });
  });

  it('normalizes device control profile maps and skips invalid entries', () => {
    const profiles = normalizeDeviceControlProfiles({
      'dev-1': buildProfile(),
      '': buildProfile(),
      'dev-2': { steps: [{ id: '', planningPowerW: 0 }] },
    });

    expect(profiles).toEqual({
      'dev-1': {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    });
    expect(normalizeDeviceControlProfiles([])).toBeNull();
  });
});
