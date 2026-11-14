import { describe, expect, it } from 'vitest';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import type { EvChargingState, EvObservedProbe, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { resolveFixtureDescriptorIdentity } from '../utils/deviceSnapshotFixture';

// Probe-widened fixture: the base snapshot type omits `evChargingState` (that
// is the contract under test), so the fixture builds the owner-side widened
// shape the guard narrows from. Fully typed (no cast) so the compiler validates
// the fixture against the same shape the guard narrows.
const snap = (over: Partial<TargetDeviceSnapshot & EvObservedProbe>): TargetDeviceSnapshot & EvObservedProbe => ({ expectedPowerKw: 1, expectedPowerSource: 'default',
  id: 'd1',
  name: 'D',
  targets: [],
  ...over,
  ...resolveFixtureDescriptorIdentity(over),
  available: over.available ?? true,
});

describe('isEvObserved', () => {
  it('is false for a non-EV device (even with a charging state present)', () => {
    expect(isEvObserved(snap({ deviceClass: 'heater', isEvCharger: false, evChargingState: 'plugged_in_charging' }))).toBe(false);
  });

  it('is true for an EV charger with a resolved plug-state (by the producer-resolved identity)', () => {
    const s = snap({ deviceClass: 'evcharger', isEvCharger: true, evChargingState: 'plugged_in_charging' });
    expect(isEvObserved(s)).toBe(true);
  });

  it('is true for an EV charger identified by control capability', () => {
    const s = snap({ isEvCharger: true, evChargingState: 'plugged_out' });
    expect(isEvObserved(s)).toBe(true);
  });

  it('is false until an EV charger has an accepted plug-state observation', () => {
    expect(isEvObserved(snap({ deviceClass: 'evcharger', isEvCharger: true, evChargingState: undefined }))).toBe(false);
  });

  it('narrows evChargingState to a non-undefined EvChargingState', () => {
    const s = snap({ deviceClass: 'evcharger', isEvCharger: true, evChargingState: 'plugged_in_paused' });
    if (isEvObserved(s)) {
      // Compile-time: `s.evChargingState` is `EvChargingState` (not `| undefined`).
      const known: EvChargingState = s.evChargingState;
      expect(known).toBe('plugged_in_paused');
    } else {
      throw new Error('expected isEvObserved to narrow');
    }
  });
});
