import { resolveTemperatureBoostActive } from '../../lib/plan/planTemperatureBoost';
import { steppedInputDevice } from '../utils/planTestUtils';

describe('resolveTemperatureBoostActive', () => {
  it('forces boost on for the deferred limit-lower-priority lane, ignoring config/threshold', () => {
    // No temperatureBoost config and the temperature is well above any threshold: only the
    // admission-set forceBoostActive flag activates it (the limit-lower-priority lane).
    const dev = steppedInputDevice({ forceBoostActive: true, currentTemperature: 80 });
    expect(resolveTemperatureBoostActive({ dev, previousActive: false })).toBe(true);
  });

  it('does not activate without the force flag or an enabled boost config', () => {
    const dev = steppedInputDevice({ currentTemperature: 80 });
    expect(resolveTemperatureBoostActive({ dev, previousActive: false })).toBe(false);
  });

  it('does not force boost on a device that does not support temperature boost', () => {
    const dev = steppedInputDevice({ forceBoostActive: true, targets: [] });
    expect(resolveTemperatureBoostActive({ dev, previousActive: false })).toBe(false);
  });
});
