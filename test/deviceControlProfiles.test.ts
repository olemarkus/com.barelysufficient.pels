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
} from '../lib/utils/deviceControlProfiles';
import type { SteppedLoadProfile } from '../lib/utils/types';

const buildProfile = (): SteppedLoadProfile => ({
  model: 'stepped_load',
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
      model: 'stepped_load',
      steps: [{ id: 'idle', planningPowerW: 0 }],
    };
    const emptyProfile = { model: 'stepped_load', steps: [] } as unknown as SteppedLoadProfile;

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
      model: 'stepped_load',
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
      model: 'stepped_load',
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
      model: 'stepped_load',
      steps: [
        { id: 'dup', planningPowerW: 0 },
        { id: 'dup', planningPowerW: 1000 },
      ],
    });
    const invalidPower = normalizeSteppedLoadProfile({
      model: 'stepped_load',
      steps: [
        { id: 'bad', planningPowerW: -1 },
      ],
    });

    expect(valid).toEqual({
      model: 'stepped_load',
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
    expect(normalizeSteppedLoadProfile({ model: 'binary_power', steps: [] })).toBeNull();
    expect(normalizeSteppedLoadProfile({ model: 'stepped_load', steps: {} })).toBeNull();
    expect(normalizeSteppedLoadProfile({
      model: 'stepped_load',
      steps: [null, { id: '', planningPowerW: 500 }],
    })).toBeNull();
    expect(normalizeSteppedLoadProfile({
      model: 'stepped_load',
      steps: [{ id: 'x', planningPowerW: 500 }],
    })).toEqual({
      model: 'stepped_load',
      steps: [{ id: 'x', planningPowerW: 500 }],
    });
  });

  it('normalizes device control profile maps and skips invalid entries', () => {
    const profiles = normalizeDeviceControlProfiles({
      'dev-1': buildProfile(),
      '': buildProfile(),
      'dev-2': { model: 'stepped_load', steps: [{ id: '', planningPowerW: 0 }] },
    });

    expect(profiles).toEqual({
      'dev-1': {
        model: 'stepped_load',
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
