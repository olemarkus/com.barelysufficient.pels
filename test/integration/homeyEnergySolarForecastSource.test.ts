import { describe, expect, it } from 'vitest';
import {
  HomeyEnergySolarForecastSource,
  type SolarForecastDayRead,
} from '../../lib/solar/homeyEnergySolarForecast';

const HOUR_MS = 3_600_000;
// 2026-08-25T10:00:00Z — noon in Europe/Oslo (UTC+2 in August).
const NOW_MS = Date.UTC(2026, 7, 25, 10);
const TZ = 'Europe/Oslo';

const dayBody = (dateKey: string, watts: number): unknown => {
  // One valid midday point per day is enough for the classification tests.
  const noonUtcMs = Date.parse(`${dateKey}T10:00:00.000Z`);
  return { resolution: 15, points: [{ t: new Date(noonUtcMs).toISOString(), watts }], totalWh: watts / 4 };
};

const makeSource = (
  reads: Record<string, SolarForecastDayRead>,
): { source: HomeyEnergySolarForecastSource; fetches: string[] } => {
  const fetches: string[] = [];
  const source = new HomeyEnergySolarForecastSource({
    fetchForecastDay: async (dateKey) => {
      fetches.push(dateKey);
      return reads[dateKey] ?? { kind: 'unavailable' };
    },
    getTimeZone: () => TZ,
    getNowMs: () => NOW_MS,
  });
  return { source, fetches };
};

describe('HomeyEnergySolarForecastSource', () => {
  it('fetches today and tomorrow as local calendar dates and serves hourly kWh', async () => {
    const { source, fetches } = makeSource({
      '2026-08-25': { kind: 'resolved', body: dayBody('2026-08-25', 2000) },
      '2026-08-26': { kind: 'resolved', body: dayBody('2026-08-26', 1000) },
    });
    expect(await source.refresh(NOW_MS)).toBe('ok');
    expect(fetches).toEqual(['2026-08-25', '2026-08-26']);
    expect(source.forecast([NOW_MS])).toEqual([{ hourStartMs: NOW_MS, generationKwh: 2 }]);
    expect(source.forecast([NOW_MS + 24 * HOUR_MS])).toEqual([
      { hourStartMs: NOW_MS + 24 * HOUR_MS, generationKwh: 1 },
    ]);
    // Hours Homey has no point for are skipped, never guessed.
    expect(source.forecast([NOW_MS + HOUR_MS])).toEqual([]);
  });

  it('is ok when today resolves and tomorrow is legitimately absent', async () => {
    const { source } = makeSource({
      '2026-08-25': { kind: 'resolved', body: dayBody('2026-08-25', 2000) },
      '2026-08-26': { kind: 'unavailable' },
    });
    expect(await source.refresh(NOW_MS)).toBe('ok');
    expect(source.hasUsefulForecast(NOW_MS)).toBe(true);
  });

  it('keeps the last good series when a refresh transiently fails (no-op rule)', async () => {
    const reads: Record<string, SolarForecastDayRead> = {
      '2026-08-25': { kind: 'resolved', body: dayBody('2026-08-25', 2000) },
      '2026-08-26': { kind: 'resolved', body: dayBody('2026-08-26', 1000) },
    };
    const { source } = makeSource(reads);
    await source.refresh(NOW_MS);
    reads['2026-08-25'] = { kind: 'failed' };
    reads['2026-08-26'] = { kind: 'failed' };
    expect(await source.refresh(NOW_MS)).toBe('failed');
    expect(source.forecast([NOW_MS])).toEqual([{ hourStartMs: NOW_MS, generationKwh: 2 }]);
  });

  it('clears the cache on a definitive unavailable answer', async () => {
    const reads: Record<string, SolarForecastDayRead> = {
      '2026-08-25': { kind: 'resolved', body: dayBody('2026-08-25', 2000) },
    };
    const { source } = makeSource(reads);
    await source.refresh(NOW_MS);
    delete reads['2026-08-25'];
    expect(await source.refresh(NOW_MS)).toBe('unavailable');
    expect(source.forecast([NOW_MS])).toEqual([]);
    expect(source.hasUsefulForecast(NOW_MS)).toBe(false);
  });

  it('treats a resolved body with zero valid points as unavailable', async () => {
    const { source } = makeSource({
      '2026-08-25': { kind: 'resolved', body: { points: [] } },
      '2026-08-26': { kind: 'resolved', body: 'not even close' },
    });
    expect(await source.refresh(NOW_MS)).toBe('unavailable');
  });

  describe('hasUsefulForecast / getConfidence', () => {
    it('is not useful when the forecast is all-zero (solar device but no real basis)', async () => {
      const { source } = makeSource({
        '2026-08-25': { kind: 'resolved', body: dayBody('2026-08-25', 0) },
      });
      expect(await source.refresh(NOW_MS)).toBe('ok');
      expect(source.hasUsefulForecast(NOW_MS)).toBe(false);
      expect(source.getConfidence()).toBeNull();
    });

    it('is not useful when past hours are positive but every forward hour is zero', async () => {
      // Sunny morning, flat remainder: past energy must not qualify the
      // forecast — usefulness is a statement about what is AHEAD.
      const { source } = makeSource({
        '2026-08-25': {
          kind: 'resolved',
          body: {
            points: [
              { t: '2026-08-25T06:00:00.000Z', watts: 3000 }, // past (now = 10:00Z)
              { t: '2026-08-25T12:00:00.000Z', watts: 0 },    // forward, zero
            ],
            totalWh: 750,
          },
        },
      });
      expect(await source.refresh(NOW_MS)).toBe('ok');
      expect(source.hasUsefulForecast(NOW_MS)).toBe(false);
      expect(source.getConfidence()).toBeNull();
    });

    it('is not useful when every cached hour is already in the past', async () => {
      const { source } = makeSource({
        '2026-08-25': { kind: 'resolved', body: dayBody('2026-08-25', 2000) },
      });
      await source.refresh(NOW_MS);
      expect(source.hasUsefulForecast(NOW_MS)).toBe(true);
      expect(source.hasUsefulForecast(NOW_MS + 2 * HOUR_MS)).toBe(false);
    });

    it('reports high confidence while a useful forecast exists', async () => {
      const { source } = makeSource({
        '2026-08-25': { kind: 'resolved', body: dayBody('2026-08-25', 2000) },
      });
      await source.refresh(NOW_MS);
      expect(source.getConfidence()).toBe('high');
    });
  });

  it('summarizes the cache for the structured refresh log', async () => {
    const { source } = makeSource({
      '2026-08-25': { kind: 'resolved', body: dayBody('2026-08-25', 2000) },
      '2026-08-26': { kind: 'resolved', body: dayBody('2026-08-26', 1000) },
    });
    await source.refresh(NOW_MS);
    const summary = source.summarize(NOW_MS);
    expect(summary.hourCount).toBe(2);
    expect(summary.next24hKwh).toBe(2); // tomorrow's point sits exactly 24 h out — outside the window
    expect(summary.firstHourStartMs).toBe(NOW_MS);
    expect(summary.lastHourStartMs).toBe(NOW_MS + 24 * HOUR_MS);
    expect(summary.totalWhReported).toBe(750);
  });
});
