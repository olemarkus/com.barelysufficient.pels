import { estimatePower } from '../lib/core/powerEstimate';
import type { HomeyDeviceLike } from '../lib/utils/types';

const logger = {
  log: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

const buildState = () => ({
  expectedPowerKwOverrides: {},
  lastKnownPowerKw: {},
  lastMeasuredPowerKw: {},
  lastMeterEnergyKwh: {},
});

const buildDevice = (load?: number): HomeyDeviceLike => ({
  id: 'dev-1',
  name: 'Device 1',
  class: 'thermostat',
  capabilities: ['target_temperature', 'measure_temperature'],
  capabilitiesObj: {
    target_temperature: { value: 21, units: '°C' },
    measure_temperature: { value: 20, units: '°C' },
  },
  settings: load === undefined ? {} : { load },
});

describe('estimatePower', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('treats settings.load=0 as unset', () => {
    const result = estimatePower({
      device: buildDevice(0),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now(),
      state: buildState(),
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: jest.fn(),
      applyMeasurementUpdates: jest.fn(),
    });

    expect(result.loadKw).toBeUndefined();
    expect(result.expectedPowerSource).toBe('default');
    expect(result.powerKw).toBe(1);
  });

  it('uses settings.load when value is greater than zero', () => {
    const updateLastKnownPower = jest.fn();
    const result = estimatePower({
      device: buildDevice(650),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now(),
      state: buildState(),
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower,
      applyMeasurementUpdates: jest.fn(),
    });

    expect(result.loadKw).toBeCloseTo(0.65, 3);
    expect(result.expectedPowerSource).toBe('load-setting');
    expect(result.powerKw).toBeCloseTo(0.65, 3);
    expect(updateLastKnownPower).toHaveBeenCalledWith('dev-1', 0.65, 'Device 1');
  });
});
