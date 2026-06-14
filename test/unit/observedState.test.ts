import {
  resolveCurrentOn,
  resolveObservedCurrentState,
  resolveObservedSteppedLoadCurrentState,
} from '../../lib/observer/observedState';
import { steppedProfile } from '../utils/planTestUtils';

describe('resolveCurrentOn — binary devices', () => {
  it('is the binary on/off as a strict boolean', () => {
    expect(resolveCurrentOn({ binaryControl: { on: true } })).toBe(true);
    expect(resolveCurrentOn({ binaryControl: { on: false } })).toBe(false);
  });

  it('trusts the last observed value — no staleness gate', () => {
    // `resolveCurrentOn` reads no freshness signal: a stale observation keeps its
    // last value (Homey reports capabilities only on change, so stale-off stays
    // off). This is the deliberate behaviour change from the retired
    // `isObservedOff`/`isObservedOn`, which collapsed stale to "neither".
    expect(resolveCurrentOn({ binaryControl: { on: false } })).toBe(false);
    expect(resolveCurrentOn({ binaryControl: { on: true } })).toBe(true);
  });
});

describe('resolveCurrentOn — stepped + binary devices (step-off folds in)', () => {
  const stepInput = (
    overrides: Partial<{ binaryControl: { on: boolean }; selectedStepId: string | undefined }>,
  ) => ({
    binaryControl: { on: true } as { on: boolean },
    steppedLoadProfile: steppedProfile,
    ...overrides,
  });

  it('is off when binary is off, regardless of step', () => {
    expect(resolveCurrentOn(stepInput({ binaryControl: { on: false }, selectedStepId: 'medium' }))).toBe(false);
  });

  it('is off when binary is on but the step is at the off step', () => {
    expect(resolveCurrentOn(stepInput({ selectedStepId: 'off' }))).toBe(false);
  });

  it('is on when binary is on AND the step is active', () => {
    expect(resolveCurrentOn(stepInput({ selectedStepId: 'low' }))).toBe(true);
  });

  it('is on (may-draw default) when the step is unknown', () => {
    // A binary device is never "unknown": an unresolved step collapses to
    // on/sheddable rather than introducing a third state.
    expect(resolveCurrentOn(stepInput({ selectedStepId: undefined }))).toBe(true);
  });
});

describe('resolveObservedCurrentState — four-valued label (separate from the on/off truth)', () => {
  it('returns "unknown" for stale observations with binary control', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: false },
      controlCapabilityId: 'onoff',
      observationStale: true,
    })).toBe('unknown');
  });

  it('returns "not_applicable" for stale observations on a target-only device', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: false },
      observationStale: true,
      controlCapabilityId: undefined,
    })).toBe('not_applicable');
  });

  it('resolves a step-only device from its step state, not its defaulted binary', () => {
    expect(resolveObservedSteppedLoadCurrentState({
      binaryControl: { on: false },
      controlCapabilityId: undefined,
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'medium',
    })).toBe('on');
  });
});
