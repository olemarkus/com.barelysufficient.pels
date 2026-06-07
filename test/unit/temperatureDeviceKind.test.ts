import { describe, expect, it } from 'vitest';
import {
  isStarvationSupportedDeviceClass,
  isTemperatureControlDevice,
} from '../../packages/shared-domain/src/temperatureDeviceKind';

describe('isTemperatureControlDevice', () => {
  it('is true only for the temperature deviceType modality', () => {
    expect(isTemperatureControlDevice({ deviceType: 'temperature' })).toBe(true);
    expect(isTemperatureControlDevice({ deviceType: 'onoff' })).toBe(false);
    expect(isTemperatureControlDevice({})).toBe(false);
    expect(isTemperatureControlDevice(undefined)).toBe(false);
  });
});

describe('isStarvationSupportedDeviceClass', () => {
  it('matches the thermostat-family classes, case-insensitively', () => {
    for (const cls of ['thermostat', 'heater', 'heatpump', 'airconditioning', 'airtreatment']) {
      expect(isStarvationSupportedDeviceClass(cls)).toBe(true);
      expect(isStarvationSupportedDeviceClass(cls.toUpperCase())).toBe(true);
      expect(isStarvationSupportedDeviceClass(`  ${cls}  `)).toBe(true);
    }
  });

  it('rejects non-thermostat classes and empties', () => {
    for (const cls of ['evcharger', 'socket', 'light', '', undefined]) {
      expect(isStarvationSupportedDeviceClass(cls)).toBe(false);
    }
  });
});
