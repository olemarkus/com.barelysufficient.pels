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

    const anchorMs = Date.parse('2026-01-01T00:00:00.000Z');
    const oneHourLaterMs = Date.parse('2026-01-01T01:00:00.000Z');

    now = anchorMs;
    expect(resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: {
        meterEnergy: { kwh: 100, observedAtMs: anchorMs },
        homeyEnergyLiveW: 125,
        homeyEnergyObservedAtMs: anchorMs,
      },
    })).toEqual({ observedAtMs: anchorMs });

    // 1 kWh accrued across an hour of OBSERVED time is 1 kW. The observation
    // stamps carry that hour; `now` agreeing with them here is incidental, and
    // the case below pins that the stamps are what decide.
    now = oneHourLaterMs;
    expect(resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: {
        meterEnergy: { kwh: 101, observedAtMs: oneHourLaterMs },
        homeyEnergyLiveW: 125,
        homeyEnergyObservedAtMs: oneHourLaterMs,
      },
    })).toEqual({ measuredPowerKw: 1, observedAtMs: oneHourLaterMs });
    expect(lastPositiveMeasuredPowerKw['dev-1']).toEqual({ kw: 1, ts: now });
  });

  // The production defect (a ~3.8 kW air conditioner reporting 226 kW). The
  // owning app publishes `meter_power` on its own cadence — here a 15-minute
  // cloud poll — while the resolver runs on the snapshot refresh 15 seconds
  // apart. Pairing the poll's energy with the refresh's elapsed time overstates
  // the rate 60x. Both terms must come from the observation clock.
  it('derives the rate from observation time, not from how often it is asked', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      getNow: () => now,
    });

    const firstPollMs = Date.parse('2026-01-01T00:00:00.000Z');
    const secondPollMs = firstPollMs + 15 * 60 * 1000;

    resolver.resolve({
      deviceId: 'ac-1',
      deviceLabel: 'Daikin',
      observation: { meterEnergy: { kwh: 100, observedAtMs: firstPollMs } },
    });

    // The refresh that first SEES the new poll runs 15 s after the one before
    // it, but the 0.95 kWh it carries accrued over the preceding 15 minutes.
    now = secondPollMs + 15_000;
    const resolved = resolver.resolve({
      deviceId: 'ac-1',
      deviceLabel: 'Daikin',
      observation: { meterEnergy: { kwh: 100.95, observedAtMs: secondPollMs } },
    });

    expect(resolved.measuredPowerKw).toBeCloseTo(3.8, 6);
  });

  // The quieter half of the same defect: for most of every poll interval the
  // cumulative value has not moved, and the old arithmetic divided that zero by
  // real elapsed time to credit the device a measured 0 kW while it was running.
  it('reports absence, not a measured zero, when the meter has not been re-observed', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      getNow: () => now,
    });

    const observedAtMs = now;
    resolver.resolve({
      deviceId: 'ac-1',
      deviceLabel: 'Daikin',
      observation: { meterEnergy: { kwh: 100, observedAtMs } },
    });

    // Ten refreshes later the capability still carries the same reading at the
    // same stamp: no new information, so no reading.
    now += 150_000;
    expect(resolver.resolve({
      deviceId: 'ac-1',
      deviceLabel: 'Daikin',
      observation: { meterEnergy: { kwh: 100, observedAtMs } },
    })).toEqual({ observedAtMs });
  });

  // The contrast to the case above, and why absence there is not a blanket "a
  // flat meter says nothing": an app that re-publishes an unchanged meter moves
  // its observation clock, so the pair spans a real window over zero energy.
  // That IS a measured zero and must be reported as one.
  it('reports a true zero when an unchanged meter is re-published', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      getNow: () => 0,
    });

    const firstMs = Date.parse('2026-01-01T00:00:00.000Z');
    resolver.resolve({
      deviceId: 'heater-1',
      deviceLabel: 'Heater',
      observation: { meterEnergy: { kwh: 42, observedAtMs: firstMs } },
    });

    const republishedMs = firstMs + 10 * 60 * 1000;
    expect(resolver.resolve({
      deviceId: 'heater-1',
      deviceLabel: 'Heater',
      observation: { meterEnergy: { kwh: 42, observedAtMs: republishedMs } },
    })).toEqual({ measuredPowerKw: 0, observedAtMs: republishedMs });
    expect(lastPositiveMeasuredPowerKw).toEqual({});
  });

  // A refresh on which the meter did not resolve to a reading (the reader
  // answered absence) must not disturb the anchor: the next dated reading
  // pairs with the standing one, so the energy is counted across the whole
  // span it accrued over.
  it('leaves the anchor standing across an observation with no meter reading', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      getNow: () => 0,
    });

    const anchorMs = Date.parse('2026-01-01T00:00:00.000Z');
    resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: { meterEnergy: { kwh: 100, observedAtMs: anchorMs } },
    });

    expect(resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: {},
    })).toEqual({});

    const laterMs = anchorMs + 60 * 60 * 1000;
    expect(resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: { meterEnergy: { kwh: 102, observedAtMs: laterMs } },
    })).toEqual({ measuredPowerKw: 2, observedAtMs: laterMs });
  });

  // Skipping a too-close pair must not consume it: advancing the anchor on a
  // skip would drop that interval's energy for good.
  it('carries energy forward when two observations land inside the same second', () => {
    const lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
    const resolver = new DeviceMeasuredPowerResolver({
      logger,
      lastPositiveMeasuredPowerKw,
      getNow: () => 0,
    });

    const anchorMs = Date.parse('2026-01-01T00:00:00.000Z');
    resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: { meterEnergy: { kwh: 100, observedAtMs: anchorMs } },
    });

    expect(resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: { meterEnergy: { kwh: 100.4, observedAtMs: anchorMs + 500 } },
    })).toEqual({ observedAtMs: anchorMs + 500 });

    // 1 kWh total across one hour from the original anchor — the 0.4 kWh that
    // was skipped is included, not lost.
    const laterMs = anchorMs + 60 * 60 * 1000;
    expect(resolver.resolve({
      deviceId: 'dev-1',
      deviceLabel: 'Device 1',
      observation: { meterEnergy: { kwh: 101, observedAtMs: laterMs } },
    })).toEqual({ measuredPowerKw: 1, observedAtMs: laterMs });
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
