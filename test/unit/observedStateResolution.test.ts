import { resolveObservedCurrentState } from '../../lib/observer/observedState';

describe('plan state resolution', () => {
  // The contract that makes a whole card branch unreachable, pinned here so the
  // branch cannot quietly come back. `not_applicable` means "this device has no
  // on/off truth", and for a STEPPED device that can only happen when its rung
  // is unknown — the stepped label is consulted first and only falls through on
  // 'unknown'. So "stepped, rung known, yet not_applicable" is not a state the
  // producer can emit, which is why the held-card verb no longer has a
  // target-only-at-a-non-off-step arm.
  it('never answers not_applicable for a stepped device whose rung is known', () => {
    const profile = {
      steps: [{ id: 'step_0', planningPowerW: 0 }, { id: 'low', planningPowerW: 1_000 }],
    };
    expect(resolveObservedCurrentState({
      steppedLoadProfile: profile,
      selectedStepId: 'low',
    })).toBe('on');
    expect(resolveObservedCurrentState({
      steppedLoadProfile: profile,
      selectedStepId: 'step_0',
    })).toBe('off');
  });

  it('answers not_applicable for a stepped device only when the rung is unknown', () => {
    expect(resolveObservedCurrentState({
      steppedLoadProfile: {
        steps: [{ id: 'step_0', planningPowerW: 0 }, { id: 'low', planningPowerW: 1_000 }],
      },
      selectedStepId: undefined,
    })).toBe('not_applicable');
  });

  it('returns not_applicable for fresh devices without binary control', () => {
    expect(resolveObservedCurrentState({})).toBe('not_applicable');
  });

  it('returns not_applicable for fresh devices without binary control when currentOn is false', () => {
    expect(resolveObservedCurrentState({})).toBe('not_applicable');
  });

  it('returns not_applicable for a device without binary capability (structural, not staleness)', () => {
    expect(resolveObservedCurrentState({})).toBe('not_applicable');
  });

  it('resolves a binary device to its latched off label — never unknown from staleness', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: false },
    })).toBe('off');
  });
});
