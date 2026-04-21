import { DeviceMeasuredPowerResolver } from '../lib/core/deviceMeasuredPowerResolver';

const logger = {
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: {
    debug: vi.fn(),
  },
};

describe('DeviceMeasuredPowerResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers measure_power over Homey Energy live watts', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      minSignificantPowerW: 5,
      getNow: () => 1000,
    });

    const measuredPower = resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: {
        measurePowerW: 80,
        measurePowerObservedAtMs: 900,
        homeyEnergyLiveW: 125,
        homeyEnergyObservedAtMs: 950,
      },
    });

    expect(measuredPower.measuredPowerKw).toBeCloseTo(0.08, 6);
    expect(measuredPower.observedAtMs).toBe(900);
    expect(lastPositiveMeasuredPowerKw['dev-1']).toEqual({ kw: 0.08, ts: 1000 });
  });

  it('uses meter_power when measure_power is absent and does not fall through to Homey Energy first', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    let now = 0;
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      minSignificantPowerW: 5,
      getNow: () => now,
    });

    now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: {
        meterPowerKwh: 100,
        meterPowerObservedAtMs: 100,
        homeyEnergyLiveW: 125,
        homeyEnergyObservedAtMs: 200,
      },
    })).toEqual({ observedAtMs: 100 });

    now = Date.parse('2026-01-01T01:00:00.000Z');
    expect(resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: {
        meterPowerKwh: 101,
        meterPowerObservedAtMs: 3600,
        homeyEnergyLiveW: 125,
        homeyEnergyObservedAtMs: 3700,
      },
    })).toEqual({ measuredPowerKw: 1, observedAtMs: 3600 });
    expect(lastPositiveMeasuredPowerKw['dev-1']).toEqual({ kw: 1, ts: now });
  });

  it('falls back to Homey Energy live watts when no direct capabilities are available', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      minSignificantPowerW: 5,
      getNow: () => 2000,
    });

    const measuredPower = resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: {
        homeyEnergyLiveW: 125,
        homeyEnergyObservedAtMs: 1500,
      },
    });

    expect(measuredPower.measuredPowerKw).toBeCloseTo(0.125, 6);
    expect(measuredPower.observedAtMs).toBe(1500);
    expect(lastPositiveMeasuredPowerKw['dev-1']).toEqual({ kw: 0.125, ts: 2000 });
  });

  it('treats a low measure_power reading as authoritative, does not fall through, and still reports freshness', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      minSignificantPowerW: 5,
    });

    const measuredPower = resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: {
        measurePowerW: 4,
        measurePowerObservedAtMs: 1234,
        homeyEnergyLiveW: 125,
        homeyEnergyObservedAtMs: 2345,
      },
    });

    expect(measuredPower).toEqual({ observedAtMs: 1234 });
    expect(lastPositiveMeasuredPowerKw).toEqual({});
  });
});
