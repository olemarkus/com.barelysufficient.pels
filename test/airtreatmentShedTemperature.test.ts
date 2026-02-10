import {
  computeDefaultAirtreatmentShedTemperature,
  normalizeShedTemperature,
} from '../lib/utils/airtreatmentShedTemperature';

describe('airtreatment shed temperature utils', () => {
  describe('normalizeShedTemperature', () => {
    it('clamps and rounds to configured step', () => {
      expect(normalizeShedTemperature(45)).toBe(40);
      expect(normalizeShedTemperature(-25)).toBe(-20);
      expect(normalizeShedTemperature(17.24)).toBe(17);
      expect(normalizeShedTemperature(17.26)).toBe(17.5);
    });
  });

  describe('computeDefaultAirtreatmentShedTemperature', () => {
    it('uses fallback target when no mode/current target is available', () => {
      expect(computeDefaultAirtreatmentShedTemperature({ modeTarget: null, currentTarget: null })).toBe(17);
    });

    it('prefers mode target over current target', () => {
      expect(computeDefaultAirtreatmentShedTemperature({ modeTarget: 22, currentTarget: 19 })).toBe(19);
    });

    it('uses current target when mode target is missing', () => {
      expect(computeDefaultAirtreatmentShedTemperature({ modeTarget: null, currentTarget: 21 })).toBe(18);
    });

    it('enforces floor and max clamp', () => {
      expect(computeDefaultAirtreatmentShedTemperature({ modeTarget: 15, currentTarget: null })).toBe(16);
      expect(computeDefaultAirtreatmentShedTemperature({ modeTarget: 100, currentTarget: null })).toBe(40);
    });

    it('supports a lower custom floor for non-onoff temperature devices', () => {
      expect(computeDefaultAirtreatmentShedTemperature({ modeTarget: 12, currentTarget: null, minFloorC: 10 })).toBe(10);
    });
  });
});
