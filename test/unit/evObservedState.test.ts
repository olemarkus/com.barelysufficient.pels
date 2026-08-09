import { describe, expect, it } from 'vitest';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import type { EvObservedProbe, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

// Probe-widened fixture: the base snapshot type omits `evChargingState` (that
// is the contract under test), so the fixture builds the owner-side widened
// shape the guard narrows from. Fully typed (no cast) so the compiler validates
// the fixture against the same shape the guard narrows.
const snap = (over: Partial<TargetDeviceSnapshot & EvObservedProbe>): TargetDeviceSnapshot & EvObservedProbe => ({
  id: 'd1',
  name: 'D',
  targets: [],
  ...over,
});

describe('isEvObserved', () => {
  it('is false for a non-EV device (even with a charging state present)', () => {
    expect(isEvObserved(snap({ deviceClass: 'heater', evChargingState: 'plugged_in_charging' }))).toBe(false);
  });

  it('is true for an EV charger with a resolved plug-state (by deviceClass)', () => {
    const s = snap({ deviceClass: 'evcharger', evChargingState: 'plugged_in_charging' });
    expect(isEvObserved(s)).toBe(true);
  });

  it('is true for an EV charger identified by control capability', () => {
    const s = snap({ controlCapabilityId: 'evcharger_charging', evChargingState: 'plugged_out' });
    expect(isEvObserved(s)).toBe(true);
  });

  it('is true for an EV charger regardless of the fixture carrying a state', () => {
    // The predicate is EV-ness alone: presence is a parse-boundary guarantee, not
    // something consumers re-check. Every `evcharger` must expose
    // `evcharger_charging_state` (`resolveCandidateCapabilities`) and report a
    // member of the Homey enum for it (`shouldDropForEvPlugStateContract`), or it
    // is dropped rather than managed — so "EV charger with no plug-state" is not a
    // device that reaches a consumer. A fixture that omits it is simply not a
    // device the producer could have built.
    expect(isEvObserved(snap({ deviceClass: 'evcharger', evChargingState: undefined }))).toBe(true);
  });

  it('narrows evChargingState to a non-undefined EvChargingState', () => {
    const s = snap({ deviceClass: 'evcharger', evChargingState: 'plugged_in_paused' });
    if (isEvObserved(s)) {
      // Compile-time: `s.evChargingState` is `EvChargingState` (not `| undefined`).
      const known: 'plugged_in_charging' | 'plugged_in' | 'plugged_in_paused' | 'plugged_out'
        | 'plugged_in_discharging' = s.evChargingState;
      expect(known).toBe('plugged_in_paused');
    } else {
      throw new Error('expected isEvObserved to narrow');
    }
  });
});
