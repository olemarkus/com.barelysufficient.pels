import { applyFreshnessOnlyCapabilityUpdate } from '../../lib/device/transport/managerFreshness';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

// Minimal EV snapshot — the freshness handler only touches the EV fields below.
const evSnapshot = (
  evChargingState: string | undefined,
  evCharging: boolean,
): TargetDeviceSnapshot => ({
  id: 'ev1',
  name: 'EV',
  evChargingState,
  evCharging,
  binaryControl: { on: evCharging },
} as unknown as TargetDeviceSnapshot);

describe('applyFreshnessOnlyCapabilityUpdate — evcharger_charging_state', () => {
  it('applies a known→known realtime transition', () => {
    const snapshot = evSnapshot('plugged_in_charging', true);
    const result = applyFreshnessOnlyCapabilityUpdate({
      snapshot,
      capabilityId: 'evcharger_charging_state',
      value: 'plugged_out',
    });
    expect(result.changed).toBe(true);
    expect(snapshot.evChargingState).toBe('plugged_out');
  });

  it('normalises an out-of-enum realtime value to undefined — never strands the prior state', () => {
    // Regression for the realtime-seam P1: a charger that leaves a known state
    // for an unrecognised value must transition to the uncommandable unknown
    // state, not retain the stale (still commandable) `plugged_in_charging`.
    const snapshot = evSnapshot('plugged_in_charging', false);
    const result = applyFreshnessOnlyCapabilityUpdate({
      snapshot,
      capabilityId: 'evcharger_charging_state',
      value: 'mystery',
    });
    expect(result.changed).toBe(true);
    expect(snapshot.evChargingState).toBeUndefined();
    // undefined defers to the evcharger_charging boolean (false here) → off.
    expect(snapshot.binaryControl?.on).toBe(false);
  });

  it('ignores a non-string realtime value, leaving the prior state intact', () => {
    const snapshot = evSnapshot('plugged_in_charging', true);
    const result = applyFreshnessOnlyCapabilityUpdate({
      snapshot,
      capabilityId: 'evcharger_charging_state',
      value: 42,
    });
    expect(result.changed).toBe(false);
    expect(snapshot.evChargingState).toBe('plugged_in_charging');
  });
});
