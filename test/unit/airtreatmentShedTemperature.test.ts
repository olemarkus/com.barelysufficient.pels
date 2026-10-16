import {
  computeDefaultSetpointShedTemperature,
  normalizeShedTemperature,
} from '../../packages/shared-domain/src/utils/airtreatmentShedTemperature';

describe('airtreatment shed temperature utils', () => {
  describe('normalizeShedTemperature', () => {
    it('clamps and rounds to configured step', () => {
      expect(normalizeShedTemperature(45)).toBe(40);
      expect(normalizeShedTemperature(-25)).toBe(-20);
      expect(normalizeShedTemperature(17.24)).toBe(17);
      expect(normalizeShedTemperature(17.26)).toBe(17.5);
    });
  });

  describe('computeDefaultSetpointShedTemperature', () => {
    it('uses the fixed base when the mode holds no target', () => {
      expect(computeDefaultSetpointShedTemperature(null, 10)).toBe(17);
    });

    it('sets back from the mode target', () => {
      expect(computeDefaultSetpointShedTemperature(22, 10)).toBe(19);
    });

    it('enforces the floor and the max clamp', () => {
      expect(computeDefaultSetpointShedTemperature(15, 16)).toBe(16);
      expect(computeDefaultSetpointShedTemperature(12, 10)).toBe(10);
      expect(computeDefaultSetpointShedTemperature(100, 10)).toBe(40);
    });
  });
});
