import { isEvObserved } from '../../lib/device/evObservedState';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

const snap = (over: Partial<TargetDeviceSnapshot>): TargetDeviceSnapshot => ({
  id: 'd1',
  name: 'D',
  ...over,
} as unknown as TargetDeviceSnapshot);

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

  it('is false for an EV charger with no resolved state yet (cold start)', () => {
    expect(isEvObserved(snap({ deviceClass: 'evcharger', evChargingState: undefined }))).toBe(false);
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
