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

  it('returns not_applicable for a device without binary capability (structural, not staleness)', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: false },
      controlCapabilityId: undefined,
    })).toBe('not_applicable');
  });

  it('resolves a binary device to its latched off label — never unknown from staleness', () => {
    expect(resolveObservedCurrentState({
      binaryControl: { on: false },
      controlCapabilityId: 'onoff',
    })).toBe('off');
  });
});
