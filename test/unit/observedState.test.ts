import {
  isObservedOff,
  isObservedOn,
  resolveObservedCurrentState,
  resolveObservedSteppedLoadCurrentState,
} from '../../lib/observer/observedState';
import { steppedProfile } from '../utils/planTestUtils';

describe('isObservedOff / isObservedOn — binary-only devices', () => {
  it('reports off iff fresh and binary says off', () => {
    expect(isObservedOff({ currentOn: false })).toBe(true);
    expect(isObservedOff({ currentOn: true })).toBe(false);
    expect(isObservedOn({ currentOn: false })).toBe(false);
    expect(isObservedOn({ currentOn: true })).toBe(true);
  });

  it('treats stale observations as neither confirmed off nor on', () => {
    expect(isObservedOff({ currentOn: false, observationStale: true })).toBe(false);
    expect(isObservedOn({ currentOn: true, observationStale: true })).toBe(false);
  });
});

describe('isObservedOff / isObservedOn — stepped + binary devices', () => {
  const stepInput = (overrides: Record<string, unknown>) => ({
    currentOn: true,
    hasBinaryControl: true,
    controlModel: 'stepped_load' as const,
    steppedLoadProfile: steppedProfile,
    ...overrides,
  });

  it('reports off when binary is off, regardless of step', () => {
    expect(isObservedOff(stepInput({ currentOn: false, selectedStepId: 'medium' }))).toBe(true);
    expect(isObservedOn(stepInput({ currentOn: false, selectedStepId: 'medium' }))).toBe(false);
  });

  it('reports off when binary is on but step is at the off step', () => {
    expect(isObservedOff(stepInput({ selectedStepId: 'off' }))).toBe(true);
    expect(isObservedOn(stepInput({ selectedStepId: 'off' }))).toBe(false);
  });

  it('reports on only when binary is on AND step is active', () => {
    expect(isObservedOn(stepInput({ selectedStepId: 'low' }))).toBe(true);
    expect(isObservedOff(stepInput({ selectedStepId: 'low' }))).toBe(false);
  });

  it('reports neither confirmed when step is unknown', () => {
    expect(isObservedOff(stepInput({ selectedStepId: undefined }))).toBe(false);
    expect(isObservedOn(stepInput({ selectedStepId: undefined }))).toBe(false);
  });
});

describe('isObservedOff / isObservedOn — step-only devices (no binary capability)', () => {
  const stepOnlyInput = (overrides: Record<string, unknown>) => ({
    // Step-only devices have no onoff capability; the defaulted currentOn=false
    // must not be inferred as authoritative — only the step state matters.
    currentOn: false,
    hasBinaryControl: false,
    controlModel: 'stepped_load' as const,
    steppedLoadProfile: steppedProfile,
    ...overrides,
  });

  it('reports off when the selected step is the off step, ignoring defaulted currentOn', () => {
    expect(isObservedOff(stepOnlyInput({ selectedStepId: 'off' }))).toBe(true);
    expect(isObservedOn(stepOnlyInput({ selectedStepId: 'off' }))).toBe(false);
  });

  it('reports on when the selected step is an active step, ignoring defaulted currentOn', () => {
    // Regression: under the old logic, currentOn=false short-circuited to off
    // for step-only devices too — masking the active step.
    expect(isObservedOn(stepOnlyInput({ selectedStepId: 'medium' }))).toBe(true);
    expect(isObservedOff(stepOnlyInput({ selectedStepId: 'medium' }))).toBe(false);
  });
});

describe('isObservedOff / isObservedOn — devices with no controllable capability', () => {
  it('returns false for both helpers — planner makes no binary intent for such devices', () => {
    expect(isObservedOff({ currentOn: false, hasBinaryControl: false })).toBe(false);
    expect(isObservedOn({ currentOn: false, hasBinaryControl: false })).toBe(false);
    expect(isObservedOn({ currentOn: true, hasBinaryControl: false })).toBe(false);
  });
});

describe('precomputed currentState string', () => {
  it('honors an explicit precomputed state when callers pass one', () => {
    expect(isObservedOff({ currentState: 'off' })).toBe(true);
    expect(isObservedOff({ currentState: 'on' })).toBe(false);
    expect(isObservedOff({ currentState: 'unknown' })).toBe(false);
    expect(isObservedOn({ currentState: 'on' })).toBe(true);
    expect(isObservedOn({ currentState: 'off' })).toBe(false);
  });
});

describe('resolveObservedCurrentState — string projection stays consistent', () => {
  it('returns "unknown" for stale observations with binary control', () => {
    expect(resolveObservedCurrentState({
      currentOn: false,
      observationStale: true,
    })).toBe('unknown');
  });

  it('returns "not_applicable" for stale observations on a target-only device', () => {
    expect(resolveObservedCurrentState({
      currentOn: false,
      observationStale: true,
      hasBinaryControl: false,
    })).toBe('not_applicable');
  });

  it('resolves a step-only device from its step state, not its defaulted binary', () => {
    expect(resolveObservedSteppedLoadCurrentState({
      currentOn: false,
      hasBinaryControl: false,
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'medium',
    })).toBe('on');
  });
});
