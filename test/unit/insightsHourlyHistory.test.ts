import { readHourlyInsightsLogs, resolveHourlyInsightsHistory } from '../../lib/power/insightsHourlyHistory';
import { buildHourlyInsightsHistory } from '../helpers/hourlyInsightsHistory';
import { captureLogger } from '../utils/loggerCapture';

describe('Insights hourly usage admission', () => {
  it('accepts raw manager metadata lists and rejects a conflicting owner', () => {
    const fixture = buildHourlyInsightsHistory();
    const raw = Object.values(fixture.metadata).map(({ uri: _uri, ...log }) => ({
      ...log, ownerUri: 'homey:device:meter-a',
    }));
    expect(readHourlyInsightsLogs(raw, 'meter-a')).toEqual(readHourlyInsightsLogs(fixture.metadata, 'meter-a'));
    expect(() => readHourlyInsightsLogs(raw.map((log) => ({ ...log, ownerUri: 'homey:device:other' })),
      'meter-a')).toThrow();
  });
  it('admits hourly W details after retained-hour and export validation', () => {
    const fixture = buildHourlyInsightsHistory();
    const logs = readHourlyInsightsLogs(fixture.metadata, 'meter-a');
    const hours = resolveHourlyInsightsHistory(fixture.power, fixture.exported, logs, fixture.tracker, fixture.nowMs);
    expect(hours).toEqual(Object.fromEntries(fixture.power.values.slice(1, -1).map(({ t, v }) => [t, v / 1000])));
  });

  it('skips a genuine null power gap without inventing an hourly value', () => {
    const fixture = buildHourlyInsightsHistory();
    const logs = readHourlyInsightsLogs(fixture.metadata, 'meter-a');
    const missing = fixture.power.values[12].t;
    const power = { ...fixture.power,
      values: fixture.power.values.map((point) => point.t === missing ? { ...point, v: null } : point) };
    const hours = resolveHourlyInsightsHistory(power, fixture.exported, logs, fixture.tracker, fixture.nowMs);
    expect(Object.keys(hours)).toHaveLength(165);
    expect(Object.hasOwn(hours, missing)).toBe(false);
    const invalid = { ...power, values: [{ t: 'broken', v: null }, ...power.values] };
    expect(() => resolveHourlyInsightsHistory(
      invalid, fixture.exported, logs, fixture.tracker, fixture.nowMs,
    )).toThrow();
  });

  it.each([NaN, false])('recovers other hours when one reading is %s and one hour is net export', (badReading) => {
    const fixture = buildHourlyInsightsHistory();
    const logs = readHourlyInsightsLogs(fixture.metadata, 'meter-a');
    const netExport = fixture.power.values[12].t;
    const missing = fixture.power.values[150].t; // Remove a retained hour and exercise the overlap minimum.
    const power = { ...fixture.power, values: fixture.power.values.map((point) => {
      if (point.t === netExport) return { ...point, v: -700 };
      if (point.t === missing) return badReading === false ? badReading : { ...point, v: badReading };
      return point;
    }) };
    const capture = captureLogger();
    try {
      const hours = resolveHourlyInsightsHistory(power, fixture.exported, logs, fixture.tracker, fixture.nowMs);
      expect(hours).toEqual(Object.fromEntries(fixture.power.values.slice(1, -1).flatMap(({ t, v }) => (
        t === missing ? [] : [[t, t === netExport ? 0 : v / 1000]]
      ))));
      expect(capture.findEvents('power_history_recovery_point_skipped')).toEqual([
        expect.objectContaining({
          module: 'power/history-recovery', logId: logs.power.id, index: 150,
          ...(badReading === false ? { reason: 'non_record' } : { reason: 'invalid_value', hour: missing }),
        }),
      ]);
    } finally {
      capture.restore();
    }
  });

  it('rejects another meter, wrong units, coarse data, and invalid timestamps', () => {
    const fixture = buildHourlyInsightsHistory();
    expect(() => readHourlyInsightsLogs(fixture.metadata, 'meter-b')).toThrow();
    expect(() => readHourlyInsightsLogs({ ...fixture.metadata,
      power: { ...fixture.metadata.power, units: 'kW' } }, 'meter-a')).toThrow();
    const logs = readHourlyInsightsLogs(fixture.metadata, 'meter-a');
    for (const power of [
      { ...fixture.power, step: 21_600_000 },
      { ...fixture.power, id: 'wrong-log' },
      { ...fixture.power, values: undefined },
      { ...fixture.power, values: [{ v: 1200 }, ...fixture.power.values] },
      { ...fixture.power, values: [fixture.power.values[0], ...fixture.power.values] },
      { ...fixture.power, values: [{ ...fixture.power.values[0], t: '2026-11-11T16:01:00Z' }] },
    ]) expect(() => resolveHourlyInsightsHistory(power, fixture.exported, logs, fixture.tracker, fixture.nowMs)).toThrow();
  });

  it('uses the surrounding export readings to admit hours independently', () => {
    const fixture = buildHourlyInsightsHistory();
    const logs = readHourlyInsightsLogs(fixture.metadata, 'meter-a');
    const power = { ...fixture.power, values: fixture.power.values.map((point, i) => {
      if (i === 12) return { ...point, v: -700 };
      if (i === 13) return { ...point, v: 0 };
      return point;
    }) };
    const exported = { ...fixture.exported, values: fixture.exported.values.map((point, i) => {
      if (i === 8) return { ...point, v: null };
      return { ...point, v: i >= 13 && i < 19 ? 1 : 0 };
    }) };
    const hours = resolveHourlyInsightsHistory(power, exported, logs, fixture.tracker, fixture.nowMs);
    expect(hours).toEqual(Object.fromEntries(power.values.flatMap(({ t, v }, i) => (
      [0, 13, 18, 19, power.values.length - 1].includes(i) ? [] : [[t, Math.max(0, v) / 1000]]
    ))));
  });

  it('rejects a shifted, mismatched, flat or insufficient overlap', () => {
    const fixture = buildHourlyInsightsHistory();
    const logs = readHourlyInsightsLogs(fixture.metadata, 'meter-a');
    const shifted = { ...fixture.power, values: fixture.power.values.map(({ t, v }) => ({
      t: new Date(Date.parse(t) + 3_600_000).toISOString(), v,
    })) };
    expect(() => resolveHourlyInsightsHistory(shifted, fixture.exported, logs, fixture.tracker, fixture.nowMs)).toThrow();
    expect(() => resolveHourlyInsightsHistory(fixture.power, fixture.exported, logs, {
      ...fixture.tracker, buckets: Object.fromEntries(Object.entries(fixture.tracker.buckets ?? {}).slice(2)),
    }, fixture.nowMs)).toThrow();
    const flat = { ...fixture.power, values: fixture.power.values.map((point) => ({ ...point, v: 2000 })) };
    const flatTracker = { ...fixture.tracker,
      buckets: Object.fromEntries(Object.keys(fixture.tracker.buckets ?? {}).map((key) => [key, 2])) };
    expect(() => resolveHourlyInsightsHistory(flat, fixture.exported, logs, flatTracker, fixture.nowMs)).toThrow();
    expect(() => resolveHourlyInsightsHistory(fixture.power, fixture.exported, logs, {
      ...fixture.tracker, buckets: Object.fromEntries(Object.entries(fixture.tracker.buckets ?? {}).map(([key, v]) => [key, v * 2])),
    }, fixture.nowMs)).toThrow();
  });
});
