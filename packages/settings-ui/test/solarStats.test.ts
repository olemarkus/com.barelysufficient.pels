import { describe, expect, it } from 'vitest';
import {
  buildSolarDayRows,
  buildTodaySolarHourMaps,
  resolveSolarCardVisible,
  SOLAR_USAGE_MIN_EXPORT_KWH,
} from '../src/ui/solarStats.ts';

const OSLO = 'Europe/Oslo';
const HOUR_MS = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('buildSolarDayRows', () => {
  it('folds UTC hours into local days with per-day totals and self-use rate', () => {
    // 2026-06-15 10:00/11:00 UTC = 12:00/13:00 Oslo (same local day).
    const h0 = Date.UTC(2026, 5, 15, 10, 0, 0);
    const rows = buildSolarDayRows({
      generationBuckets: { [iso(h0)]: 2, [iso(h0 + HOUR_MS)]: 2 },
      exportBuckets: { [iso(h0)]: 1 },
      timeZone: OSLO,
      todayKey: '2026-06-15',
    });
    expect(rows).toEqual([{
      dateKey: '2026-06-15',
      generatedKWh: 4,
      exportedKWh: 1,
      selfUsedKWh: 3,
      selfUseRate: 0.75,
    }]);
  });

  it('applies the per-hour floor so a battery-export hour cannot drag the day negative', () => {
    const h0 = Date.UTC(2026, 5, 15, 10, 0, 0);
    const rows = buildSolarDayRows({
      generationBuckets: { [iso(h0)]: 1, [iso(h0 + HOUR_MS)]: 2 },
      exportBuckets: { [iso(h0)]: 3 },
      timeZone: OSLO,
      todayKey: '2026-06-15',
    });
    // Hour 0 self-use floors at 0; hour 1 contributes 2.
    expect(rows[0]?.selfUsedKWh).toBe(2);
    expect(rows[0]?.exportedKWh).toBe(3);
  });

  it('nulls the self-use rate under 0.05 kWh generated', () => {
    const h0 = Date.UTC(2026, 5, 15, 10, 0, 0);
    const rows = buildSolarDayRows({
      generationBuckets: { [iso(h0)]: 0.04 },
      timeZone: OSLO,
      todayKey: '2026-06-15',
    });
    expect(rows[0]?.selfUseRate).toBeNull();
  });

  it('keeps only the 7-day window, newest first, and drops junk values/keys', () => {
    const today = Date.UTC(2026, 5, 15, 10, 0, 0);
    const rows = buildSolarDayRows({
      generationBuckets: {
        [iso(today)]: 1,
        [iso(today - 3 * 24 * HOUR_MS)]: 2,
        [iso(today - 9 * 24 * HOUR_MS)]: 5, // outside window
        'not-a-date': 3,
        [iso(today - 24 * HOUR_MS)]: Number.NaN, // junk value → contributes 0 → day omitted
      },
      timeZone: OSLO,
      todayKey: '2026-06-15',
    });
    expect(rows.map((row) => row.dateKey)).toEqual(['2026-06-15', '2026-06-12']);
  });

  it('folds a DST fall-back local day (25 hours) into a single row', () => {
    // 2026-10-25 Oslo has 25 local hours: 2026-10-24T22:00Z .. 2026-10-25T22:00Z.
    const startUtc = Date.UTC(2026, 9, 24, 22, 0, 0);
    const generationBuckets: Record<string, number> = {};
    for (let ts = startUtc; ts <= startUtc + 24 * HOUR_MS; ts += HOUR_MS) {
      generationBuckets[iso(ts)] = 0.1;
    }
    const rows = buildSolarDayRows({
      generationBuckets,
      timeZone: OSLO,
      todayKey: '2026-10-25',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dateKey).toBe('2026-10-25');
    expect(rows[0]?.generatedKWh).toBeCloseTo(2.5, 6);
  });
});

describe('buildTodaySolarHourMaps', () => {
  it("returns only today's hours keyed by epoch hour-start", () => {
    const todayHour = Date.UTC(2026, 5, 15, 10, 0, 0);
    const yesterdayHour = todayHour - 24 * HOUR_MS;
    const maps = buildTodaySolarHourMaps({
      generationBuckets: { [iso(todayHour)]: 2, [iso(yesterdayHour)]: 5 },
      exportBuckets: { [iso(todayHour)]: 0.5 },
      timeZone: OSLO,
      todayKey: '2026-06-15',
    });
    expect(maps.todayHourStartsMs).toEqual([todayHour]);
    expect(maps.generationKWhByHourMs.get(todayHour)).toBe(2);
    expect(maps.exportKWhByHourMs.get(todayHour)).toBe(0.5);
  });
});

describe('resolveSolarCardVisible', () => {
  const emptyRows: never[] = [];

  it('always shows the card for a home with a tracked solar device', () => {
    expect(resolveSolarCardVisible({
      hasManagedSolarDevice: true,
      generationBuckets: undefined,
      rows: emptyRows,
    })).toBe(true);
  });

  it('shows the card on any recorded generation', () => {
    expect(resolveSolarCardVisible({
      hasManagedSolarDevice: false,
      generationBuckets: { '2026-06-15T10:00:00.000Z': 0.01 },
      rows: emptyRows,
    })).toBe(true);
  });

  it('export alone must clear the 7-day materiality floor', () => {
    const below = [{
      dateKey: '2026-06-15',
      generatedKWh: 0,
      exportedKWh: SOLAR_USAGE_MIN_EXPORT_KWH - 0.01,
      selfUsedKWh: 0,
      selfUseRate: null,
    }];
    expect(resolveSolarCardVisible({
      hasManagedSolarDevice: false,
      generationBuckets: undefined,
      rows: below,
    })).toBe(false);
    const atFloor = [{ ...below[0]!, exportedKWh: SOLAR_USAGE_MIN_EXPORT_KWH }];
    expect(resolveSolarCardVisible({
      hasManagedSolarDevice: false,
      generationBuckets: undefined,
      rows: atFloor,
    })).toBe(true);
  });

  it('stays hidden for a plain non-solar home', () => {
    expect(resolveSolarCardVisible({
      hasManagedSolarDevice: false,
      generationBuckets: undefined,
      rows: emptyRows,
    })).toBe(false);
  });
});
