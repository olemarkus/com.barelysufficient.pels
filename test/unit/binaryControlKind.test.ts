import { describe, expect, it } from 'vitest';
import { hasBinaryControlCapability } from '../../packages/shared-domain/src/binaryControlKind';
import { isBinaryControlled } from '../../packages/shared-domain/src/binaryControlState';

describe('hasBinaryControlCapability', () => {
  it('is true exactly when the producer exposes a semantic binary axis', () => {
    expect(hasBinaryControlCapability({ binaryControllable: true })).toBe(true);
    expect(hasBinaryControlCapability({ currentOn: false })).toBe(true);
    expect(hasBinaryControlCapability({ binaryControl: { on: true } })).toBe(true);
    expect(hasBinaryControlCapability({})).toBe(false);
    expect(hasBinaryControlCapability(undefined)).toBe(false);
    expect(hasBinaryControlCapability(null)).toBe(false);
  });

  it('is NOT the observed-state question — a binary device before its first observation', () => {
    const unobservedBinary = { binaryControllable: true, binaryControl: undefined };
    expect(hasBinaryControlCapability(unobservedBinary)).toBe(true);
    expect(isBinaryControlled(unobservedBinary)).toBe(false);
  });
});
