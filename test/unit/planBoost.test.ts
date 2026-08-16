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
  confirmedNotDrawing?: boolean;
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

  it('refuses a forced request on a device PELS cannot drive a boost on', () => {
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

  it('releases the boost when the device is confidently drawing nothing', () => {
    // A boost is a claim on other devices' power — it escalates past the
    // fairness invariant and lets a swap pause a running lower-priority device.
    // A water heater holding at its element setpoint cannot spend what it
    // claims, so the claim goes back. One rule, both axes, every consumer: the
    // restore path no longer asks this question a second time for itself.
    expect(resolveBoostActive(device({
      boostSupported: true,
      boostRequested: true,
      confirmedNotDrawing: true,
    }))).toBe(false);
  });

  it('releases a FORCED boost on a device drawing nothing too', () => {
    // The rescue lane's claim buys the smart task nothing on a device that is
    // not taking load either, and it costs the same lower-priority devices.
    expect(resolveBoostActive(device({
      boostSupported: true,
      forceBoostActive: true,
      confirmedNotDrawing: true,
    }))).toBe(false);
  });

  it('keeps boosting while the producer has no confident idle verdict', () => {
    // `confirmedNotDrawing` is two-state and `false` covers "no calibration
    // opinion" — a warm-up device, or one mid-climb whose new rung has no
    // samples yet. Absence of evidence must not release the boost, or a boosted
    // staircase stalls a rung at a time (prod 2026-07-05).
    expect(resolveBoostActive(device({
      boostSupported: true,
      boostRequested: true,
      confirmedNotDrawing: false,
    }))).toBe(true);
  });
});
