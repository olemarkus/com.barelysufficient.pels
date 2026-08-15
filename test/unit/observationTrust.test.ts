import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import {
  getTrustedCurrentTemperatureC,
  getTrustedStateOfCharge,
} from '../../lib/utils/observationTrust';

describe('observation value accessors', () => {
  describe('getTrustedCurrentTemperatureC', () => {
    it('returns the temperature when the value is finite', () => {
      expect(getTrustedCurrentTemperatureC({ currentTemperature: 21.5 })).toBe(21.5);
    });

    it('returns the temperature regardless of staleness (no staleness gate)', () => {
      // The plan device carries no staleness, and boost trusts the latched finite
      // temperature — there is no staleness gate here (intended).
      expect(getTrustedCurrentTemperatureC({ currentTemperature: 21.5 })).toBe(21.5);
    });

    it('returns undefined when temperature is missing', () => {
      expect(getTrustedCurrentTemperatureC({})).toBeUndefined();
    });

    it('returns undefined when temperature is not finite', () => {
      expect(getTrustedCurrentTemperatureC({ currentTemperature: Number.NaN })).toBeUndefined();
    });
  });

  describe('getTrustedStateOfCharge', () => {
    it('returns the percentage when the producer has a level', () => {
      expect(getTrustedStateOfCharge({
        stateOfCharge: stateOfChargeFixture({ percent: 42 }),
      })).toBe(42);
    });

    it('returns undefined when the producer has no level', () => {
      // Both arms, and no third state: the producer either stands behind a level
      // or it does not. There is no qualifier to interpret and nothing to age.
      expect(getTrustedStateOfCharge({
        stateOfCharge: stateOfChargeFixture({ percent: 42, observedAtMs: 1_000, unavailable: 'not_reported' }),
      })).toBeUndefined();
      expect(getTrustedStateOfCharge({
        stateOfCharge: stateOfChargeFixture({ percent: 42, observedAtMs: 1_000, unavailable: 'not_connected' }),
      })).toBeUndefined();
    });

    // No "absent bag" case: the parameter REQUIRES the narrowed facet, so a
    // caller holding a device that might not report a level must narrow through
    // `hasObservedStateOfCharge` first — the compiler asks the question instead
    // of this function answering it with `undefined`.
  });
});
