import {
  getTrustedCurrentTemperatureC,
  getTrustedStateOfCharge,
  isDeviceObservationTrusted,
} from '../lib/observer/observationTrust';

describe('observation trust', () => {
  describe('isDeviceObservationTrusted', () => {
    it('returns true when observationStale is undefined', () => {
      expect(isDeviceObservationTrusted({})).toBe(true);
    });

    it('returns true when observationStale is explicitly false', () => {
      expect(isDeviceObservationTrusted({ observationStale: false })).toBe(true);
    });

    it('returns false when observationStale is true', () => {
      expect(isDeviceObservationTrusted({ observationStale: true })).toBe(false);
    });
  });

  describe('getTrustedCurrentTemperatureC', () => {
    it('returns the temperature when observation is fresh and value is finite', () => {
      expect(getTrustedCurrentTemperatureC({ currentTemperature: 21.5 })).toBe(21.5);
    });

    it('returns undefined when observation is stale', () => {
      expect(getTrustedCurrentTemperatureC({
        observationStale: true,
        currentTemperature: 21.5,
      })).toBeUndefined();
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
      source: 'capability' as const,
    };

    it('returns the snapshot when fresh', () => {
      expect(getTrustedStateOfCharge({ stateOfCharge: freshSoC })).toEqual(freshSoC);
    });

    it('returns undefined when observation is stale', () => {
      expect(getTrustedStateOfCharge({
        observationStale: true,
        stateOfCharge: freshSoC,
      })).toBeUndefined();
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
