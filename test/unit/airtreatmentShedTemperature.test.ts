import {
  resolveSetpointShedFloorC,
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

  describe('resolveSetpointShedFloorC', () => {
    it.each([5, 20, 40, 45, 4.2])('uses the device minimum %s without the old 40 °C cap or half-degree rounding', (min) => {
      expect(resolveSetpointShedFloorC({
        deviceClass: 'heater', targets: [{ id: 'target_temperature', value: 70, unit: '°C', min }],
      })).toBe(min);
    });

    it.each([['heater', 10], ['airtreatment', 16], [' AIRTREATMENT ', 16]])(
      'retains the %s fallback only when the device supplies no minimum', (deviceClass, expected) => {
        expect(resolveSetpointShedFloorC({
          deviceClass: String(deviceClass), targets: [{ id: 'target_temperature', value: 70, unit: '°C' }],
        })).toBe(expected);
      },
    );
  });
});
