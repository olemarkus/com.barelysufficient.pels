import { isGrayStateDevice, requiresNativeWiringForActivation } from '../src/ui/deviceUtils.ts';

describe('isGrayStateDevice', () => {
  it('flags unavailable, stale, and disappeared devices as gray', () => {
    expect(isGrayStateDevice({ available: false })).toBe(true);
    expect(isGrayStateDevice({ observationStale: true })).toBe(true);
    expect(isGrayStateDevice({ currentState: 'unknown' })).toBe(true);
    expect(isGrayStateDevice({ currentState: 'disappeared' })).toBe(true);
  });

  it('keeps active devices out of the gray state', () => {
    expect(isGrayStateDevice({ available: true, currentState: 'on' })).toBe(false);
    expect(isGrayStateDevice({ available: true, currentState: 'off' })).toBe(false);
  });
});

describe('requiresNativeWiringForActivation', () => {
  it('requires native wiring only when Zaptec-style support exists without an effective EV control capability', () => {
    expect(requiresNativeWiringForActivation({
      controlAdapter: { kind: 'capability_adapter', activationRequired: true, activationEnabled: false },
      controlCapabilityId: undefined,
    } as any)).toBe(true);
    expect(requiresNativeWiringForActivation({
      controlAdapter: { kind: 'capability_adapter', activationRequired: true, activationEnabled: true },
      controlCapabilityId: undefined,
    } as any)).toBe(false);
    expect(requiresNativeWiringForActivation({
      controlAdapter: { kind: 'capability_adapter', activationRequired: true, activationEnabled: false },
      controlCapabilityId: 'evcharger_charging',
    } as any)).toBe(false);
  });
});
