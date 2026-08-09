import { describe, expect, it } from 'vitest';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  supportsSmartTaskObjective,
  supportsTemperatureObjective,
} from '../../flowCards/smartTaskDeviceCapability';

const buildDevice = (
  overrides: Partial<DecoratedDeviceSnapshot> = {},
): DecoratedDeviceSnapshot => ({ expectedPowerKw: 1, expectedPowerSource: 'default',
  id: 'heater-1',
  name: 'Heater',
  deviceType: 'temperature',
  targets: [{ id: 'target_temperature', value: 20, unit: '°C' }],
  ...overrides,
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
