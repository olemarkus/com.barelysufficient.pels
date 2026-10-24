import {
  computeDefaultSetpointShedTemperature,
  normalizeShedTemperature,
} from '../../packages/shared-domain/src/utils/airtreatmentShedTemperature';

describe('airtreatment shed temperature utils', () => {
  describe('normalizeShedTemperature', () => {
    it('clamps to the saved-limit range and rounds to configured step', () => {
      // A water heater's limit may sit well above a room's: the device's own
      // target range bounds what is written.
      expect(normalizeShedTemperature(55)).toBe(55);
      expect(normalizeShedTemperature(95)).toBe(90);
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

    it('enforces the floor and caps the default at 40 °C', () => {
      expect(computeDefaultSetpointShedTemperature(15, 16)).toBe(16);
      expect(computeDefaultSetpointShedTemperature(12, 10)).toBe(10);
      // A 65 °C tank's default is 40 °C, not 62 °C: a setback from its target
      // would let it keep heating while limited.
      expect(computeDefaultSetpointShedTemperature(65, 10)).toBe(40);
      expect(computeDefaultSetpointShedTemperature(100, 10)).toBe(40);
    });
  });
});
