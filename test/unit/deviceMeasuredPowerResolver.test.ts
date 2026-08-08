import { DeviceMeasuredPowerResolver } from '../../lib/device/measuredPowerResolver';
import type { Logger } from '../../lib/utils/types';

const logger = {
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  structuredLog: {
    debug: vi.fn(),
  },
} as unknown as Logger;

describe('DeviceMeasuredPowerResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers measure_power over Homey Energy live watts', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
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

  it('reports a few watts of standby as its own value instead of dropping it', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      getNow: () => 5000,
    });

    const measuredPower = resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: {
        measurePowerW: 3,
        measurePowerObservedAtMs: 1234,
        homeyEnergyLiveW: 125,
        homeyEnergyObservedAtMs: 2345,
      },
    });

    // A dropped reading is indistinguishable downstream from "this device has no
    // `measure_power`", and absence is what licenses a consumer to substitute
    // RATED power — so 3 W could be booked as kilowatts. Report the reading.
    expect(measuredPower).toEqual({ measuredPowerKw: 0.003, observedAtMs: 1234 });
    expect(lastPositiveMeasuredPowerKw['dev-1']).toEqual({ kw: 0.003, ts: 5000 });
  });

  it('reports a measured zero as a reading, not as absence', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({ logger, lastPositiveMeasuredPowerKw });

    const measuredPower = resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: { measurePowerW: 0, measurePowerObservedAtMs: 1234 },
    });

    expect(measuredPower).toEqual({ measuredPowerKw: 0, observedAtMs: 1234 });
    // Zero is a draw of nothing, not a positive reading.
    expect(lastPositiveMeasuredPowerKw).toEqual({});
  });

  it('drops a negative measure_power reading rather than reporting it as a draw', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({ logger, lastPositiveMeasuredPowerKw });

    const measuredPower = resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: { measurePowerW: -250, measurePowerObservedAtMs: 1234 },
    });

    // Negative is generation, not consumption. The producer states "not a draw"
    // so the contract's "present implies non-negative" holds for consumers.
    expect(measuredPower).toEqual({ observedAtMs: 1234 });
    expect(lastPositiveMeasuredPowerKw).toEqual({});
  });
});
