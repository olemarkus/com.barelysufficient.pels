import { describe, expect, it } from 'vitest';
import {
  learnPvHourShape,
  pvHourShapeFactor,
  PV_HOUR_SHAPE_MAX_FACTOR,
  PV_HOUR_SHAPE_MIN_SAMPLES,
  type PvHourShapeSample,
} from '../../lib/solar/pvHourShape';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const GAIN = 0.0005;
const START = Date.UTC(2026, 4, 1);

const at = (day: number, utcHour: number): number => START + day * DAY_MS + utcHour * HOUR_MS;

/** One recorded hour: irradiance, and generation = gain × irradiance × factor. */
const sample = (day: number, utcHour: number, irradianceWm2: number, factor: number): PvHourShapeSample => ({
  hourStartMs: at(day, utcHour),
  irradianceWm2,
  generationKwh: GAIN * irradianceWm2 * factor,
});

describe('learnPvHourShape', () => {
  it('learns a morning boost and an afternoon cut for an east-facing roof', () => {
    const samples = Array.from({ length: 20 }, (_, day) => [
      sample(day, 7, 300, 1.6),
      sample(day, 11, 800, 1),
      sample(day, 15, 400, 0.6),
    ]).flat();
    const shape = learnPvHourShape(samples, GAIN);
    expect(shape.get(7)).toBeCloseTo(1.6, 6);
    expect(shape.get(11)).toBeCloseTo(1, 6);
    expect(shape.get(15)).toBeCloseTo(0.6, 6);
  });

  it('gives no factor to an hour with too few recorded hours', () => {
    const samples = Array.from({ length: PV_HOUR_SHAPE_MIN_SAMPLES - 1 }, (_, day) => sample(day, 7, 300, 1.6));
    const shape = learnPvHourShape(samples, GAIN);
    expect(shape.has(7)).toBe(false);
    expect(pvHourShapeFactor(shape, at(30, 7))).toBe(1);
  });

  it('keeps the factor within its bounds', () => {
    const samples = Array.from({ length: 12 }, (_, day) => sample(day, 6, 100, 4));
    expect(learnPvHourShape(samples, GAIN).get(6)).toBe(PV_HOUR_SHAPE_MAX_FACTOR);
  });

  it('weighs hours where a cloud the weather model missed dims the output a quarter', () => {
    // 8 clear days at the true 1.0 ratio, then 12 days where the forecast said
    // clear but a missed cloud cut the output to 20 %. Unweighted, the misses
    // are the majority and would set the median at 0.2.
    const clear = Array.from({ length: 8 }, (_, day) => sample(day, 10, 800, 1));
    const missed = Array.from({ length: 12 }, (_, day) => sample(8 + day, 10, 800, 0.2));
    const shape = learnPvHourShape([...clear, ...missed], GAIN);
    // 12 misses at weight 0.25 = 3 against 8 clear hours: the clear ratio wins.
    expect(shape.get(10)).toBeCloseTo(1, 6);
  });

  it('skips clamp-suspect and too-dim hours', () => {
    const suspect = Array.from({ length: 20 }, (_, day) => ({
      ...sample(day, 12, 800, 0.4),
      netEvidence: 'suspect' as const,
    }));
    const dim = Array.from({ length: 20 }, (_, day) => sample(day, 18, 30, 1.5));
    const shape = learnPvHourShape([...suspect, ...dim], GAIN);
    expect(shape.size).toBe(0);
  });

  it('keys by UTC hour, so a daylight-saving change does not move a factor', () => {
    // Oslo leaves summer time on 2026-10-25. The same UTC hour meets the sun at
    // the same place before and after, and keeps one factor.
    const dstEnd = Date.UTC(2026, 9, 25);
    const samples = Array.from({ length: 20 }, (_, i) => ({
      hourStartMs: dstEnd + (i - 10) * DAY_MS + 8 * HOUR_MS,
      irradianceWm2: 300,
      generationKwh: GAIN * 300 * 1.4,
    }));
    const shape = learnPvHourShape(samples, GAIN);
    expect(shape.size).toBe(1);
    expect(pvHourShapeFactor(shape, dstEnd - 3 * DAY_MS + 8 * HOUR_MS)).toBeCloseTo(1.4, 6);
    expect(pvHourShapeFactor(shape, dstEnd + 3 * DAY_MS + 8 * HOUR_MS)).toBeCloseTo(1.4, 6);
  });

  it('lets recent days outweigh old ones as the season moves', () => {
    const old = Array.from({ length: 11 }, (_, day) => sample(day, 9, 500, 0.8));
    const recent = Array.from({ length: 10 }, (_, day) => sample(80 + day, 9, 500, 1.3));
    expect(learnPvHourShape([...old, ...recent], GAIN).get(9)).toBeCloseTo(1.3, 6);
  });
});
