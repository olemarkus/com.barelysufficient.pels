import { describe, expect, it } from 'vitest';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';

// Starvation eligibility moved to device configuration, which resolves it from
// the class into `starvationSupported`; its cases live in
// `test/unit/deviceConfiguration.test.ts`.

describe('isTemperatureControlDevice', () => {
  it('is true only for the temperature deviceType modality', () => {
    expect(isTemperatureControlDevice({ deviceType: 'temperature' })).toBe(true);
    expect(isTemperatureControlDevice({ deviceType: 'onoff' })).toBe(false);
    expect(isTemperatureControlDevice({})).toBe(false);
    expect(isTemperatureControlDevice(undefined)).toBe(false);
  });
});
