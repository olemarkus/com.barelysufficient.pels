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
    const freshSoC = {
      percent: 42,
      status: 'fresh' as const,
    };

    it('returns the snapshot when its own status is fresh', () => {
      expect(getTrustedStateOfCharge({ stateOfCharge: freshSoC })).toEqual(freshSoC);
    });

    it('returns undefined when SoC status is not fresh', () => {
      expect(getTrustedStateOfCharge({
        stateOfCharge: { ...freshSoC, status: 'stale' },
      })).toBeUndefined();
      expect(getTrustedStateOfCharge({
        stateOfCharge: { ...freshSoC, status: 'unknown' },
      })).toBeUndefined();
      expect(getTrustedStateOfCharge({
        stateOfCharge: { ...freshSoC, status: 'invalid' },
      })).toBeUndefined();
    });

    it('returns undefined when percent is not finite', () => {
      expect(getTrustedStateOfCharge({
        stateOfCharge: { ...freshSoC, percent: Number.NaN },
      })).toBeUndefined();
    });

    it('returns undefined when no snapshot present', () => {
      expect(getTrustedStateOfCharge({})).toBeUndefined();
    });
  });
});
