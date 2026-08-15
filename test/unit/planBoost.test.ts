import { resolveBoostActive } from '../../lib/plan/planBoost';
import { buildPlanInputDevice } from '../utils/planTestUtils';

// The planner's whole boost decision: the producer's two bits, the runnable
// gate, and the rescue lane's forced request. The kind-specific resolution that
// produces the bits is `boostResolution.test.ts`.
const device = (overrides: {
  boostSupported?: boolean;
  boostRequested?: boolean;
  forceBoostActive?: boolean;
  controllable?: boolean;
  managed?: boolean;
  available?: boolean;
}) => buildPlanInputDevice({
  boostSupported: overrides.boostSupported ?? false,
  boostRequested: overrides.boostRequested ?? false,
  ...overrides,
});

describe('resolveBoostActive', () => {
  it('boosts when the device asks for it', () => {
    expect(resolveBoostActive(device({ boostSupported: true, boostRequested: true }))).toBe(true);
  });

  it('does not boost when it does not', () => {
    expect(resolveBoostActive(device({ boostSupported: true }))).toBe(false);
  });

  it('boosts on a forced request the device did not make itself', () => {
    // The deferred limit-lower-priority rescue lane engages boost for its planned
    // hours regardless of the device's own threshold.
    expect(resolveBoostActive(device({
      boostSupported: true,
      forceBoostActive: true,
    }))).toBe(true);
  });

  it('refuses a forced request on a device whose boost axis is not drivable', () => {
    // The gate-order invariant: an unplugged or discharging charger resolves
    // `boostSupported: false` at the producer, and force must not override it.
    expect(resolveBoostActive(device({ forceBoostActive: true }))).toBe(false);
  });

  it('does not boost a device PELS is not running this cycle', () => {
    // The runnable gate is the planner's, not the producer's: `controllable` can
    // still be flipped to true by deferred-objective admission after the producer
    // ran, which is exactly why the gate is applied here and not there.
    for (const gate of [
      { controllable: false },
      { managed: false },
      { available: false },
    ]) {
      expect(resolveBoostActive(device({
        boostSupported: true,
        boostRequested: true,
        ...gate,
      }))).toBe(false);
    }
  });

  it('lets a rescued cap-off device boost once admission has made it controllable', () => {
    expect(resolveBoostActive(device({
      boostSupported: true,
      forceBoostActive: true,
      controllable: true,
    }))).toBe(true);
  });
});
