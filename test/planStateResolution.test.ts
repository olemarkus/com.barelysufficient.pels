import { resolveObservedCurrentState } from '../lib/plan/planStateResolution';

describe('plan state resolution', () => {
  it('returns not_applicable for fresh devices without binary control', () => {
    expect(resolveObservedCurrentState({
      currentOn: true,
      hasBinaryControl: false,
    })).toBe('not_applicable');
  });

  it('returns off for fresh devices without binary control when currentOn is false', () => {
    expect(resolveObservedCurrentState({
      currentOn: false,
      hasBinaryControl: false,
    })).toBe('off');
  });

  it('returns not_applicable for stale devices without binary control', () => {
    expect(resolveObservedCurrentState({
      currentOn: false,
      hasBinaryControl: false,
      observationStale: true,
    })).toBe('not_applicable');
  });

  it('returns unknown for stale binary devices', () => {
    expect(resolveObservedCurrentState({
      currentOn: false,
      hasBinaryControl: true,
      observationStale: true,
    })).toBe('unknown');
  });
});
