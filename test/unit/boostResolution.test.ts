import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import { normalizeEvBoostSettings } from '../../packages/contracts/src/evBoost';
import {
  type BoostResolveInput,
  resolveBoostRequested,
  resolveBoostSupported,
} from '../../lib/device/deviceActionProjection';
import { steppedProfile } from '../utils/planTestUtils';

// The producer's two boost bits, tested as what they are: pure functions over a
// device's ladder, its drivability, and its own level. There is no device kind
// in the input and none in the resolvers — a charger and a water heater reach
// the same decision by the same route, differing only in which capability the
// level is read from. A tank temperature and a battery percentage are the same
// quantity in different units, so the describe blocks below are grouped by
// SOURCE, not by two independent axes. The planner half — the runnable gate, the
// draw release and the forced request — lives in `planBoost.test.ts`.
const stateOfChargeInput = (overrides: Partial<BoostResolveInput> = {}): BoostResolveInput => ({
  commandableNow: true,
  targets: [],
  steppedLoadProfile: steppedProfile,
  stateOfCharge: stateOfChargeFixture({ percent: 32 }),
  evBoost: { enabled: true, boostBelowPercent: 40 },
  ...overrides,
});

const temperatureInput = (overrides: Partial<BoostResolveInput> = {}): BoostResolveInput => ({
  commandableNow: true,
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

describe('resolveBoostRequested — level read from state of charge', () => {
  it('requests boost below its threshold with a known level', () => {
    expect(resolveBoostRequested(stateOfChargeInput())).toBe(true);
  });

  it('stops at the threshold without hysteresis', () => {
    expect(resolveBoostRequested(stateOfChargeInput({
      stateOfCharge: stateOfChargeFixture({ percent: 40 }),
    }))).toBe(false);
  });

  it('does not request without a usable level or a config', () => {
    expect(resolveBoostRequested(stateOfChargeInput({
      stateOfCharge: stateOfChargeFixture({ percent: 20, unavailable: 'not_reported' }),
    }))).toBe(false);
    expect(resolveBoostRequested(stateOfChargeInput({ stateOfCharge: undefined }))).toBe(false);
    expect(resolveBoostRequested(stateOfChargeInput({ evBoost: undefined }))).toBe(false);
  });

  it('never requests on a device PELS cannot drive right now', () => {
    // `commandableNow` is the producer's already-resolved answer to plug-state
    // plus availability. A charger that is unplugged or discharging arrives here
    // as `commandableNow: false` and gets no boost, however low its level.
    expect(resolveBoostRequested(stateOfChargeInput({
      commandableNow: false,
      stateOfCharge: stateOfChargeFixture({ percent: 5 }),
    }))).toBe(false);
  });
});

describe('resolveBoostSupported', () => {
  it('is false for a device PELS cannot drive right now', () => {
    // This is the bit a FORCED boost is gated on, so it is what stops the
    // rescue lane engaging boost on an unplugged or discharging charger.
    expect(resolveBoostSupported(stateOfChargeInput({ commandableNow: false }))).toBe(false);
    expect(resolveBoostSupported(temperatureInput({ commandableNow: false }))).toBe(false);
  });

  it('is false without a step ladder to escalate', () => {
    // Escalating a ladder is boost's only actuation, so no ladder is no boost —
    // whichever source the level comes from, and for a device with no level.
    expect(resolveBoostSupported(stateOfChargeInput({ steppedLoadProfile: undefined }))).toBe(false);
    expect(resolveBoostSupported(temperatureInput({ steppedLoadProfile: undefined }))).toBe(false);
  });

  it('is true for any drivable stepped device, with no boost config at all', () => {
    // Supported says "PELS could boost this"; wanting it is a separate question,
    // and where the level would be read is a third one this does not need to
    // answer. That is what lets the rescue lane force a boost on a stepped load
    // whose owner configured no threshold and which exposes no temperature
    // target.
    const bare = stateOfChargeInput({
      evBoost: undefined, stateOfCharge: undefined, targets: [],
    });
    expect(resolveBoostSupported(bare)).toBe(true);
    expect(resolveBoostRequested(bare)).toBe(false);
  });

  it('keys the stepped discriminant on the profile, not controlModel', () => {
    // Regression: the boost resolver used to gate on `controlModel === 'stepped_load'
    // && profile`, while every other site (planner, observer) keys on the profile
    // alone. The two are one predicate now (`hasSteppedLoadProfile`), and this
    // input carries no control model at all.
    expect(resolveBoostSupported(temperatureInput())).toBe(true);
    expect(resolveBoostRequested(temperatureInput())).toBe(true);
  });
});

describe('resolveBoostRequested — level read from temperature', () => {
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

  it('does not request without a temperature target to raise', () => {
    // The capability is the source's own gate: a temperature is only this
    // device's level if PELS has a setpoint to raise — otherwise the thermometer
    // describes the room, not a store PELS can fill. Support is unaffected: the
    // ladder is still drivable, so a forced boost still lands.
    const noTarget = temperatureInput({ targets: [] });
    expect(resolveBoostRequested(noTarget)).toBe(false);
    expect(resolveBoostSupported(noTarget)).toBe(true);
  });
});

describe('one level, read from whichever source the device has', () => {
  // No real device reports both — a charger exposes no temperature target, a
  // thermostat no state of charge — but the resolver must still be total, and
  // what it does here is the whole point of the consolidation: it reads ONE
  // level rather than polling two independent axes and OR-ing them.
  const bothSources = (overrides: Partial<BoostResolveInput> = {}): BoostResolveInput =>
    temperatureInput({
      stateOfCharge: stateOfChargeFixture({ percent: 32 }),
      evBoost: { enabled: true, boostBelowPercent: 40 },
      ...overrides,
    });

  it('takes the state of charge when the device reports one', () => {
    // Below its floor on the level that was read; the thermometer is not
    // consulted, because the level has already been answered.
    expect(resolveBoostRequested(bothSources({ currentTemperature: 20 }))).toBe(true);
  });

  it('does not fall through to a second source once a level has been read', () => {
    // A satisfied store is a satisfied store. Asking the temperature next would
    // be asking the same question twice hoping for a different answer — which is
    // exactly what the old `evRequested || temperatureRequested` did.
    expect(resolveBoostRequested(bothSources({
      stateOfCharge: stateOfChargeFixture({ percent: 90 }),
      currentTemperature: 20,
    }))).toBe(false);
  });

  it('reads the temperature when there is no state of charge to read', () => {
    expect(resolveBoostRequested(bothSources({ stateOfCharge: undefined }))).toBe(true);
  });
});
