import { resolveTemperatureBoostActive } from '../../lib/plan/planTemperatureBoost';
import { steppedInputDevice } from '../utils/planTestUtils';

describe('resolveTemperatureBoostActive', () => {
  it('forces boost on for the deferred limit-lower-priority lane, ignoring config/threshold', () => {
    // No temperatureBoost config and the temperature is well above any threshold: only the
    // admission-set forceBoostActive flag activates it (the limit-lower-priority lane).
    const dev = steppedInputDevice({ forceBoostActive: true, currentTemperature: 80 });
    expect(resolveTemperatureBoostActive(dev)).toBe(true);
  });

  it('does not activate without the force flag or an enabled boost config', () => {
    const dev = steppedInputDevice({ currentTemperature: 80 });
    expect(resolveTemperatureBoostActive(dev)).toBe(false);
  });

  it('does not force boost on a device that does not support temperature boost', () => {
    const dev = steppedInputDevice({ forceBoostActive: true, targets: [] });
    expect(resolveTemperatureBoostActive(dev)).toBe(false);
  });

  it('activates strictly below the floor', () => {
    const dev = steppedInputDevice({
      currentTemperature: 54.9,
      temperatureBoost: { enabled: true, boostBelowC: 55 },
    });
    expect(resolveTemperatureBoostActive(dev)).toBe(true);
  });

  it('does not activate at or above the floor — no exit-margin hysteresis', () => {
    // The dropped TEMPERATURE_BOOST_EXIT_MARGIN_C used to keep boost active up to floor+2 °C
    // once active. The resolver no longer takes prior state at all: the decision is simply
    // current < floor, so a device at 56 °C (inside the former 55–57 °C band) is not boosting.
    const dev = steppedInputDevice({
      currentTemperature: 56,
      temperatureBoost: { enabled: true, boostBelowC: 55 },
    });
    expect(resolveTemperatureBoostActive(dev)).toBe(false);
  });
});
