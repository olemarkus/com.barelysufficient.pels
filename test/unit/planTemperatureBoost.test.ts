import { resolveTemperatureBoostActive } from '../../lib/plan/planTemperatureBoost';
import { steppedInputDevice } from '../utils/planTestUtils';
import {
  type TemperatureDiscriminantProbe,
  withTemperatureDiscriminant,
} from '../../lib/plan/planTypes';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

// `currentTemperature` moved off `PlanInputDevice`'s base onto the orthogonal
// `TemperatureKind` cluster, so `steppedInputDevice`'s param no longer accepts it.
// Split the cluster off, build through the shared helper, then re-attach it.
const steppedTemperatureInputDevice = (
  overrides: Parameters<typeof steppedInputDevice>[0] & TemperatureDiscriminantProbe,
): PlanInputDevice => {
  const { currentTemperature, currentTarget, plannedTarget, ...rest } = overrides;
  return withTemperatureDiscriminant({
    ...steppedInputDevice(rest),
    ...(currentTemperature !== undefined ? { currentTemperature } : {}),
    ...(currentTarget !== undefined ? { currentTarget } : {}),
    ...(plannedTarget !== undefined ? { plannedTarget } : {}),
  }) as PlanInputDevice;
};

describe('resolveTemperatureBoostActive', () => {
  it('forces boost on for the deferred limit-lower-priority lane, ignoring config/threshold', () => {
    // No temperatureBoost config and the temperature is well above any threshold: only the
    // admission-set forceBoostActive flag activates it (the limit-lower-priority lane).
    const dev = steppedTemperatureInputDevice({ forceBoostActive: true, currentTemperature: 80 });
    expect(resolveTemperatureBoostActive(dev)).toBe(true);
  });

  it('does not activate without the force flag or an enabled boost config', () => {
    const dev = steppedTemperatureInputDevice({ currentTemperature: 80 });
    expect(resolveTemperatureBoostActive(dev)).toBe(false);
  });

  it('does not force boost on a device that does not support temperature boost', () => {
    const dev = steppedInputDevice({ forceBoostActive: true, targets: [] });
    expect(resolveTemperatureBoostActive(dev)).toBe(false);
  });

  it('activates strictly below the floor', () => {
    const dev = steppedTemperatureInputDevice({
      currentTemperature: 54.9,
      temperatureBoost: { enabled: true, boostBelowC: 55 },
    });
    expect(resolveTemperatureBoostActive(dev)).toBe(true);
  });

  it('keys the stepped discriminant on the profile, not controlModel', () => {
    // Regression: the boost resolver used to gate on `controlModel === 'stepped_load'
    // && profile`, while every other site (planner, observer) keys on the profile
    // alone. The two are now one predicate (`hasSteppedLoadProfile`). A device that
    // carries a valid steppedLoadProfile but no resolved controlModel must still be
    // treated as stepped — under the old AND form this returned false.
    const dev = steppedTemperatureInputDevice({
      controlModel: undefined,
      currentTemperature: 54.9,
      temperatureBoost: { enabled: true, boostBelowC: 55 },
    });
    expect(resolveTemperatureBoostActive(dev)).toBe(true);
  });

  it('does not activate at or above the floor — no exit-margin hysteresis', () => {
    // The dropped TEMPERATURE_BOOST_EXIT_MARGIN_C used to keep boost active up to floor+2 °C
    // once active. The resolver no longer takes prior state at all: the decision is simply
    // current < floor, so a device at 56 °C (inside the former 55–57 °C band) is not boosting.
    const dev = steppedTemperatureInputDevice({
      currentTemperature: 56,
      temperatureBoost: { enabled: true, boostBelowC: 55 },
    });
    expect(resolveTemperatureBoostActive(dev)).toBe(false);
  });
});
