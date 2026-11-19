import { readHourlyInsightsLogs, resolveHourlyInsightsHistory } from '../../lib/power/insightsHourlyHistory';
import { buildHourlyInsightsHistory } from '../helpers/hourlyInsightsHistory';

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
    expect(Object.keys(hours)).toHaveLength(168);
    expect(hours[fixture.power.values[0].t]).toBe(fixture.power.values[0].v / 1000);
  });

  it('skips a genuine null power gap without inventing an hourly value', () => {
    const fixture = buildHourlyInsightsHistory();
    const logs = readHourlyInsightsLogs(fixture.metadata, 'meter-a');
    const missing = fixture.power.values[12].t;
    const power = { ...fixture.power,
      values: fixture.power.values.map((point) => point.t === missing ? { ...point, v: null } : point) };
    const hours = resolveHourlyInsightsHistory(power, fixture.exported, logs, fixture.tracker, fixture.nowMs);
    expect(Object.keys(hours)).toHaveLength(167);
    expect(Object.hasOwn(hours, missing)).toBe(false);
    const invalid = { ...power, values: [{ t: 'broken', v: null }, ...power.values] };
    expect(() => resolveHourlyInsightsHistory(
      invalid, fixture.exported, logs, fixture.tracker, fixture.nowMs,
    )).toThrow();
  });

  it('rejects another meter, wrong units, coarse data, and invalid points', () => {
    const fixture = buildHourlyInsightsHistory();
    expect(() => readHourlyInsightsLogs(fixture.metadata, 'meter-b')).toThrow();
    expect(() => readHourlyInsightsLogs({ ...fixture.metadata,
      power: { ...fixture.metadata.power, units: 'kW' } }, 'meter-a')).toThrow();
    const logs = readHourlyInsightsLogs(fixture.metadata, 'meter-a');
    for (const power of [
      { ...fixture.power, step: 21_600_000 },
      { ...fixture.power, values: [{ ...fixture.power.values[0], v: NaN }] },
      { ...fixture.power, values: [{ ...fixture.power.values[0], t: '2026-11-11T16:01:00Z' }] },
    ]) expect(() => resolveHourlyInsightsHistory(power, fixture.exported, logs, fixture.tracker, fixture.nowMs)).toThrow();
  });

  it('rejects export changes, gaps and resets', () => {
    const fixture = buildHourlyInsightsHistory();
    const logs = readHourlyInsightsLogs(fixture.metadata, 'meter-a');
    for (const values of [
      fixture.exported.values.filter((_, i) => i !== 12),
      fixture.exported.values.map((point, i) => ({ ...point, v: i > 12 ? 1 : 0 })),
      fixture.exported.values.map((point, i) => ({ ...point, v: i > 12 ? 0 : 1 })),
    ]) expect(() => resolveHourlyInsightsHistory(fixture.power, { ...fixture.exported, values }, logs,
      fixture.tracker, fixture.nowMs)).toThrow();
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
