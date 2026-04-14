import { estimatePower } from '../lib/core/powerEstimate';
import type { HomeyDeviceLike } from '../lib/utils/types';

const logger = {
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: {
    debug: vi.fn(),
  },
};

const buildState = () => ({
  expectedPowerKwOverrides: {},
  lastKnownPowerKw: {},
  lastMeasuredPowerKw: {},
  lastMeterEnergyKwh: {},
  lastEstimateDecisionLogByDevice: new Map(),
  lastPeakPowerLogByDevice: new Map(),
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

const buildSocketDevice = (params?: {
  onoff?: boolean;
  energyObj?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
}): HomeyDeviceLike => ({
  id: 'dev-socket-1',
  name: 'Socket 1',
  class: 'socket',
  capabilities: ['onoff'],
  capabilitiesObj: {
    onoff: { value: params?.onoff ?? true },
  },
  settings: params?.settings,
  energyObj: params?.energyObj ?? null,
});

describe('estimatePower', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dedupes unchanged estimate decisions across repeated reads', () => {
    const state = buildState();

    estimatePower({
      device: buildDevice(650),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now(),
      state,
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    estimatePower({
      device: buildDevice(650),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now() + 1000,
      state,
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    expect(logger.structuredLog.debug).toHaveBeenCalledTimes(1);
    expect(logger.structuredLog.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_estimate_source_changed',
      source: 'load-setting',
      estimatedKw: 0.65,
    }));
  });

  it('logs again when the estimate source materially changes', () => {
    const state = buildState();

    estimatePower({
      device: buildDevice(),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now(),
      state,
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    estimatePower({
      device: buildDevice(650),
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now() + 1000,
      state,
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    expect(logger.structuredLog.debug).toHaveBeenCalledTimes(2);
    expect(logger.structuredLog.debug).toHaveBeenNthCalledWith(1, expect.objectContaining({
      event: 'power_estimate_source_changed',
      source: 'default',
      fallbackReason: 'default_1kw',
    }));
    expect(logger.structuredLog.debug).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event: 'power_estimate_source_changed',
      source: 'load-setting',
      estimatedKw: 0.65,
    }));
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
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    expect(result.loadKw).toBeUndefined();
    expect(result.expectedPowerSource).toBe('default');
    expect(result.powerKw).toBe(1);
  });

  it('uses settings.load when value is greater than zero', () => {
    const updateLastKnownPower = vi.fn();
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
      applyMeasurementUpdates: vi.fn(),
    });

    expect(result.loadKw).toBeCloseTo(0.65, 3);
    expect(result.expectedPowerSource).toBe('load-setting');
    expect(result.powerKw).toBeCloseTo(0.65, 3);
    expect(result.measuredPowerKw).toBeUndefined();
    expect(updateLastKnownPower).toHaveBeenCalledWith('dev-1', 0.65, 'Device 1');
  });

  it('uses Homey energy approximation delta (usageOn - usageOff) when available', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: true,
        energyObj: {
          approximation: {
            usageOn: 110,
            usageOff: 10,
          },
        },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now(),
      state: buildState(),
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    expect(result.expectedPowerSource).toBe('homey-energy');
    expect(result.expectedPowerKw).toBeCloseTo(0.1, 6);
    expect(result.powerKw).toBeCloseTo(0.1, 6);
    expect(result.hasEnergyEstimate).toBe(true);
    expect(result.measuredPowerKw).toBeUndefined();
  });

  it('uses canonical device settings energy values when available (usageOn - usageOff)', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: false,
        settings: {
          energy_value_on: 12.5,
          energy_value_off: 0,
        },
        energyObj: {
          approximation: {
            usageOn: 110,
            usageOff: 10,
          },
        },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now(),
      state: buildState(),
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    expect(result.expectedPowerSource).toBe('homey-energy');
    expect(result.expectedPowerKw).toBeCloseTo(0.0125, 6);
    expect(result.powerKw).toBeCloseTo(0.0125, 6);
    expect(result.hasEnergyEstimate).toBe(true);
    expect(result.measuredPowerKw).toBeUndefined();
  });

  it('ignores Homey energy usageConstant when delta/on-state estimates are unavailable', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: true,
        energyObj: {
          approximation: {
            usageConstant: 350,
          },
        },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now(),
      state: buildState(),
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    expect(result.expectedPowerSource).toBe('default');
    expect(result.powerKw).toBe(1);
    expect(result.hasEnergyEstimate).toBeUndefined();
    expect(result.measuredPowerKw).toBeUndefined();
  });

  it('falls back to energyObj.W when approximation is unavailable', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: true,
        energyObj: { W: 125 },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now(),
      state: buildState(),
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    expect(result.expectedPowerSource).toBe('homey-energy');
    expect(result.expectedPowerKw).toBeCloseTo(0.125, 6);
    expect(result.powerKw).toBeCloseTo(0.125, 6);
    expect(result.hasEnergyEstimate).toBe(true);
  });

  it('does not use energyObj.W when device is explicitly off', () => {
    const result = estimatePower({
      device: buildSocketDevice({
        onoff: false,
        energyObj: { W: 125 },
      }),
      deviceId: 'dev-socket-1',
      deviceLabel: 'Socket 1',
      powerRaw: undefined,
      meterPowerRaw: undefined,
      now: Date.now(),
      state: buildState(),
      logger,
      minSignificantPowerW: 5,
      updateLastKnownPower: vi.fn(),
      applyMeasurementUpdates: vi.fn(),
    });

    expect(result.expectedPowerSource).toBe('default');
    expect(result.powerKw).toBe(1);
    expect(result.hasEnergyEstimate).toBeUndefined();
  });
});
