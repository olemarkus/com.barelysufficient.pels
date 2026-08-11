import { describe, expect, it } from 'vitest';
import { hasBinaryControlCapability } from '../../packages/shared-domain/src/binaryControlKind';
import { isBinaryControlled } from '../../packages/shared-domain/src/binaryControlState';

describe('hasBinaryControlCapability', () => {
  it('is true exactly when a binary control capability is resolved', () => {
    expect(hasBinaryControlCapability({ controlCapabilityId: 'onoff' })).toBe(true);
    expect(hasBinaryControlCapability({ controlCapabilityId: 'evcharger_charging' })).toBe(true);
    expect(hasBinaryControlCapability({ controlCapabilityId: undefined })).toBe(false);
    expect(hasBinaryControlCapability({})).toBe(false);
    expect(hasBinaryControlCapability(undefined)).toBe(false);
    expect(hasBinaryControlCapability(null)).toBe(false);
  });

  // The confusion trap the predicate exists to keep open. These two are close
  // enough in name to be swapped for each other by a future edit, and they
  // disagree on exactly the device that matters: one PELS can command but has
  // not yet heard from. Answering the kind question with the observed-state
  // reader would classify a freshly paired switch as non-binary and route it
  // down the target-only path.
  it('is NOT the observed-state question — a binary device before its first observation', () => {
    const unobservedBinary = { controlCapabilityId: 'onoff' as const, binaryControl: undefined };
    expect(hasBinaryControlCapability(unobservedBinary)).toBe(true);
    expect(isBinaryControlled(unobservedBinary)).toBe(false);
  });

  it('is NOT the observed-state question — an observation without a control handle', () => {
    const observedNoHandle = { controlCapabilityId: undefined, binaryControl: { on: true } };
    expect(hasBinaryControlCapability(observedNoHandle)).toBe(false);
    expect(isBinaryControlled(observedNoHandle)).toBe(true);
  });
});
