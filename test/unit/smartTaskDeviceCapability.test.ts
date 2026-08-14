import { describe, expect, it } from 'vitest';
import type { DecoratedDeviceSnapshot, TemperatureObservedProbe } from '../../packages/contracts/src/types';
import {
  supportsSmartTaskObjective,
  supportsTemperatureObjective,
} from '../../flowCards/smartTaskDeviceCapability';

const buildDevice = (
  overrides: Partial<DecoratedDeviceSnapshot & TemperatureObservedProbe> = {},
): DecoratedDeviceSnapshot & TemperatureObservedProbe => ({ expectedPowerKw: 1, expectedPowerSource: 'default',
  id: 'heater-1',
  name: 'Heater',
  deviceType: 'temperature',
  temperature: { currentTemperature: 20, target: { id: 'target_temperature', value: 20, unit: '°C' } },
  targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
  ...overrides,
  available: overrides.available ?? true,
});

describe('smart-task Flow device capability', () => {
  it('rejects temperature objectives when temperature control is disabled', () => {
    const device = buildDevice({ temperatureControlDisabled: true });

    expect(supportsTemperatureObjective(device)).toBe(false);
    expect(supportsSmartTaskObjective(device)).toBe(false);
  });

  it('keeps EV objectives eligible independently of temperature control', () => {
    const device = buildDevice({
      deviceClass: 'evcharger',
      temperatureControlDisabled: true,
    });

    expect(supportsTemperatureObjective(device)).toBe(false);
    expect(supportsSmartTaskObjective(device)).toBe(true);
  });
});
