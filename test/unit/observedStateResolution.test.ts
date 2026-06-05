import { resolveObservedCurrentState } from '../../lib/observer/observedState';

describe('plan state resolution', () => {
  it('returns not_applicable for fresh devices without binary control', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: true },
      controlCapabilityId: undefined,
    })).toBe('not_applicable');
  });

  it('returns not_applicable for fresh devices without binary control when currentOn is false', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: false },
      controlCapabilityId: undefined,
    })).toBe('not_applicable');
  });

  it('returns not_applicable for stale devices without binary control', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: false },
      controlCapabilityId: undefined,
      observationStale: true,
    })).toBe('not_applicable');
  });

  it('returns unknown for stale binary devices', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: false },
      controlCapabilityId: 'onoff',
      observationStale: true,
    })).toBe('unknown');
  });
});
