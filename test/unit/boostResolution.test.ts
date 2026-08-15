import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { normalizeEvBoostSettings } from '../../packages/contracts/src/evBoost';
import {
  type BoostResolveInput,
  resolveBoostRequested,
  resolveBoostSupported,
} from '../../lib/device/deviceActionProjection';
import { steppedProfile } from '../utils/planTestUtils';

// The producer's two boost bits, tested as what they are: pure functions over a
// device's kind evidence. The planner half — the runnable gate and the forced
// request — lives in `planBoost.test.ts`; nothing here knows what a plan is.
const evInput = (overrides: Partial<BoostResolveInput> = {}): BoostResolveInput => ({
  deviceClass: 'evcharger',
  targets: [],
  steppedLoadProfile: steppedProfile,
  evChargingState: 'plugged_in_charging',
  stateOfCharge: stateOfChargeFixture({ percent: 32 }),
  evBoost: { enabled: true, boostBelowPercent: 40 },
  ...overrides,
});

const temperatureInput = (overrides: Partial<BoostResolveInput> = {}): BoostResolveInput => ({
  targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
  steppedLoadProfile: steppedProfile,
  currentTemperature: 54.9,
  temperatureBoost: { enabled: true, boostBelowC: 55 },
  ...overrides,
});

describe('normalizeEvBoostSettings', () => {
  it('keeps enabled entries with finite in-range thresholds', () => {
    expect(normalizeEvBoostSettings({
      charger: { enabled: true, boostBelowPercent: 40 },
      disabled: { enabled: false, boostBelowPercent: 20 },
      invalid: { enabled: true, boostBelowPercent: 140 },
    })).toEqual({
      charger: { enabled: true, boostBelowPercent: 40 },
    });
  });
});

describe('resolveBoostRequested — state-of-charge axis', () => {
  it('requests boost for a stepped charger below its threshold with a known level', () => {
    expect(resolveBoostRequested(evInput())).toBe(true);
  });

  it('stops at the threshold without hysteresis', () => {
    expect(resolveBoostRequested(evInput({
      stateOfCharge: stateOfChargeFixture({ percent: 40 }),
    }))).toBe(false);
  });

  it('does not request without a usable level or a config', () => {
    expect(resolveBoostRequested(evInput({
      stateOfCharge: stateOfChargeFixture({ percent: 20, unavailable: 'not_reported' }),
    }))).toBe(false);
    expect(resolveBoostRequested(evInput({ stateOfCharge: undefined }))).toBe(false);
    expect(resolveBoostRequested(evInput({ evBoost: undefined }))).toBe(false);
  });

  it('requests for a bare connected charger (plugged_in)', () => {
    // `plugged_in` is commandable — the literal is vendor-inconsistent (Easee
    // reports it while awaiting authentication, Wallbox for its own paused state),
    // so boost may request a probe; observer reachability handles a charger that
    // declines or never starts drawing.
    expect(resolveBoostRequested(evInput({
      evChargingState: 'plugged_in',
      stateOfCharge: stateOfChargeFixture({ percent: 20 }),
    }))).toBe(true);
  });
});

describe('resolveBoostSupported — state-of-charge axis', () => {
  it('is false for a charger PELS cannot drive, whatever its level says', () => {
    // This is the bit a FORCED boost is gated on, so it is what stops the
    // rescue lane engaging boost on an unplugged or discharging charger.
    expect(resolveBoostSupported(evInput({ evChargingState: 'plugged_out' }))).toBe(false);
    expect(resolveBoostSupported(evInput({ evChargingState: 'plugged_in_discharging' }))).toBe(false);
    expect(resolveBoostRequested(evInput({
      evChargingState: 'plugged_out',
      stateOfCharge: stateOfChargeFixture({ percent: 5 }),
    }))).toBe(false);
  });

  it('is false without a step ladder, and for a non-charger with no temperature target', () => {
    expect(resolveBoostSupported(evInput({ steppedLoadProfile: undefined }))).toBe(false);
    expect(resolveBoostSupported(evInput({ deviceClass: 'heater' }))).toBe(false);
  });

  it('is true for a plugged-in stepped charger with no boost config at all', () => {
    // Supported says "PELS could boost this"; wanting it is a separate question.
    const input = evInput({ evBoost: undefined, stateOfCharge: undefined });
    expect(resolveBoostSupported(input)).toBe(true);
    expect(resolveBoostRequested(input)).toBe(false);
  });
});

describe('resolveBoostRequested — temperature axis', () => {
  it('requests strictly below the floor', () => {
    expect(resolveBoostRequested(temperatureInput())).toBe(true);
  });

  it('does not request at or above the floor — no exit-margin hysteresis', () => {
    // The dropped TEMPERATURE_BOOST_EXIT_MARGIN_C used to keep boost active up to
    // floor+2 °C once active. The resolver takes no prior state at all: the
    // decision is current < floor, so a device at 56 °C is not boosting.
    expect(resolveBoostRequested(temperatureInput({ currentTemperature: 56 }))).toBe(false);
  });

  it('does not request without an enabled config', () => {
    expect(resolveBoostRequested(temperatureInput({ temperatureBoost: undefined }))).toBe(false);
    expect(resolveBoostRequested(temperatureInput({
      temperatureBoost: { enabled: false, boostBelowC: 55 },
    }))).toBe(false);
  });
});

describe('resolveBoostSupported — temperature axis', () => {
  it('is false without a temperature target to raise', () => {
    expect(resolveBoostSupported(temperatureInput({ targets: [] }))).toBe(false);
  });

  it('keys the stepped discriminant on the profile, not controlModel', () => {
    // Regression: the boost resolver used to gate on `controlModel === 'stepped_load'
    // && profile`, while every other site (planner, observer) keys on the profile
    // alone. The two are one predicate now (`hasSteppedLoadProfile`), and this
    // input carries no control model at all.
    expect(resolveBoostSupported(temperatureInput())).toBe(true);
    expect(resolveBoostRequested(temperatureInput())).toBe(true);
  });

  it('is false without a step ladder', () => {
    expect(resolveBoostSupported(temperatureInput({ steppedLoadProfile: undefined }))).toBe(false);
  });
});
