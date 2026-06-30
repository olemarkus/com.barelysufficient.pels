import {
  resolveEffectiveCurrentOn,
  resolveEffectiveCurrentState,
  resolveObservedCurrentState,
} from '../../lib/plan/planCurrentState';
import { steppedProfile } from '../utils/planTestUtils';

describe('planCurrentState', () => {
  it('resolves binary currentState values without applying pending influence', () => {
    expect(resolveEffectiveCurrentState({ currentState: 'on' })).toEqual({
      currentState: 'on',
      isOn: true,
      source: 'binary',
      reasonCode: 'observed_binary_on',
      pendingInfluence: 'none',
    });

    expect(resolveEffectiveCurrentState({ currentState: 'off' }, { pendingPresent: true })).toEqual({
      currentState: 'off',
      isOn: false,
      source: 'binary',
      reasonCode: 'observed_binary_off',
      pendingInfluence: 'present_but_not_applied',
    });
  });

  it('resolves a binary observation to its latched off — never unknown from staleness', () => {
    // The producer no longer collapses a stale binary read to 'unknown'; it
    // resolves the latched bit (here off), and the effective on/off follows.
    expect(resolveObservedCurrentState({
      binaryControl: { on: false },
      controlCapabilityId: 'onoff',
    })).toBe('off');

    expect(resolveEffectiveCurrentOn({
      binaryControl: { on: false },
      controlCapabilityId: 'onoff',
    })).toBe(false);
  });

  it('maps target-only devices to not_applicable and an unknown on/off state', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: true },
      controlCapabilityId: undefined,
    })).toBe('not_applicable');

    expect(resolveEffectiveCurrentState({
      currentState: 'not_applicable',
    })).toEqual({
      currentState: 'not_applicable',
      isOn: null,
      source: 'target',
      reasonCode: 'observed_target_only',
      pendingInfluence: 'none',
    });

    expect(resolveEffectiveCurrentState({
      currentState: 'not_applicable',
      binaryControl: { on: false },
    })).toEqual({
      currentState: 'not_applicable',
      isOn: false,
      source: 'binary',
      reasonCode: 'observed_binary_off_not_applicable',
      pendingInfluence: 'none',
    });
  });

  it('uses stepped observed state as the canonical source for stepped devices', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      controlCapabilityId: 'onoff',
    })).toBe('on');

    expect(resolveEffectiveCurrentState({
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
    })).toEqual({
      currentState: 'on',
      isOn: true,
      source: 'stepped',
      reasonCode: 'observed_step_active',
      pendingInfluence: 'none',
    });

    expect(resolveObservedCurrentState({
      binaryControl: { on: true },
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'off',
      controlCapabilityId: 'onoff',
    })).toBe('off');

    expect(resolveEffectiveCurrentState({
      currentState: 'off',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'off',
    })).toEqual({
      currentState: 'off',
      isOn: false,
      source: 'stepped',
      reasonCode: 'observed_step_off',
      pendingInfluence: 'none',
    });
  });
});
