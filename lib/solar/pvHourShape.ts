// Learned PV hour shape: a per-hour-of-day correction on top of the global gain.
//
// The gain (`pvGain.ts`) is one kWh-per-(W/m²) constant learned against
// HORIZONTAL shortwave irradiance. A roof that faces east or west turns the same
// horizontal irradiance into more energy at one end of the day and less at the
// other, so a single constant forecasts the right daily total at the wrong
// times. This module learns, for each hour of the day, how far this home's
// recorded generation sits from `gain × irradiance`, and returns that ratio as a
// bounded multiplicative factor.
//
// The hour of day is the UTC hour, not the local clock hour: the sun keeps no
// daylight saving time, so at a fixed location a UTC hour always meets the sun
// at the same point in its daily path. A local-hour key would shift every factor
// by an hour twice a year.
//
// The factor is derived from the recorded history on every refit, so it needs no
// state of its own and ages out with the history's retention window.

import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import { PV_GAIN_MIN_IRRADIANCE_WM2 } from '../../packages/shared-domain/src/solar/pvGain';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Recorded hours an hour of day needs before its factor applies: roughly two
 *  weeks of usable daylight at that hour, so a few unusual days cannot set it. */
export const PV_HOUR_SHAPE_MIN_SAMPLES = 10;

/** Factor bounds. Horizontal-to-roof irradiance ratios at the ends of the day
 *  exceed 2 for steep east/west roofs, but those hours carry little energy; the
 *  bounds keep a sparse or odd hour from moving any forecast more than twofold
 *  either way, which covers the common orientations' useful hours. */
export const PV_HOUR_SHAPE_MIN_FACTOR = 0.5;
export const PV_HOUR_SHAPE_MAX_FACTOR = 2;

/** Weight of an hour where the irradiance and the generation disagree about
 *  whether it was clear: a cloud the weather model missed (or invented) says
 *  nothing about the roof's shape, so it counts a quarter of an agreeing hour. */
export const PV_HOUR_SHAPE_WEATHER_MISS_WEIGHT = 0.25;

/** Share of the hour's bright reference above which an hour counts as clear. */
const CLEAR_SHARE = 0.6;
/** Quantile used as the hour's bright reference, robust to one stray reading. */
const BRIGHT_REFERENCE_QUANTILE = 0.9;
/** Recency half-life: the sun's path at a given hour drifts with the season, so
 *  recent days weigh more than days from the start of the retention window. */
const RECENCY_HALF_LIFE_MS = 30 * DAY_MS;

export type PvHourShapeSample = {
  hourStartMs: number;
  irradianceWm2: number;
  generationKwh: number;
  /** Zero-export clamp evidence; a `suspect` hour's output is throttled, not shaped. */
  netEvidence?: 'unclamped' | 'suspect';
};

/** Per-UTC-hour-of-day factors; an hour without enough evidence is absent and
 *  forecasts with the plain gain. */
export type PvHourShape = ReadonlyMap<number, number>;

export const utcHourOfDay = (hourStartMs: number): number => (
  ((Math.floor(hourStartMs / HOUR_MS) % 24) + 24) % 24
);

const nearestRankQuantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
};

const weightedMedian = (entries: readonly { value: number; weight: number }[]): number => {
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    if (cumulative >= total / 2) return entry.value;
  }
  return Number.NaN;
};

const clampFactor = (factor: number): number => (
  Math.min(PV_HOUR_SHAPE_MAX_FACTOR, Math.max(PV_HOUR_SHAPE_MIN_FACTOR, factor))
);

const learnHourFactor = (
  samples: readonly PvHourShapeSample[],
  gainKwhPerWm2: number,
  latestMs: number,
): number | undefined => {
  if (samples.length < PV_HOUR_SHAPE_MIN_SAMPLES) return undefined;
  const brightIrradiance = nearestRankQuantile(samples.map((s) => s.irradianceWm2), BRIGHT_REFERENCE_QUANTILE);
  const brightGeneration = nearestRankQuantile(samples.map((s) => s.generationKwh), BRIGHT_REFERENCE_QUANTILE);
  const entries = samples.map((sample) => {
    const forecastClear = sample.irradianceWm2 >= CLEAR_SHARE * brightIrradiance;
    const actualClear = sample.generationKwh >= CLEAR_SHARE * brightGeneration;
    const weatherWeight = forecastClear === actualClear ? 1 : PV_HOUR_SHAPE_WEATHER_MISS_WEIGHT;
    const recencyWeight = 0.5 ** ((latestMs - sample.hourStartMs) / RECENCY_HALF_LIFE_MS);
    return {
      value: sample.generationKwh / (gainKwhPerWm2 * sample.irradianceWm2),
      weight: weatherWeight * recencyWeight,
    };
  });
  const factor = weightedMedian(entries);
  return isFiniteNumber(factor) && factor > 0 ? clampFactor(factor) : undefined;
};

/**
 * Learn the hour shape from recorded hours against a fitted gain. Hours too dim
 * to learn from, clamp-suspect hours and non-finite readings are skipped; an hour
 * of day with fewer than `PV_HOUR_SHAPE_MIN_SAMPLES` usable hours gets no factor.
 */
export const learnPvHourShape = (
  samples: readonly PvHourShapeSample[],
  gainKwhPerWm2: number,
): PvHourShape => {
  const shape = new Map<number, number>();
  if (!isFiniteNumber(gainKwhPerWm2) || gainKwhPerWm2 <= 0) return shape;
  const byHour = new Map<number, PvHourShapeSample[]>();
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (!isFiniteNumber(sample.irradianceWm2) || sample.irradianceWm2 < PV_GAIN_MIN_IRRADIANCE_WM2) continue;
    if (!isFiniteNumber(sample.generationKwh) || sample.generationKwh < 0) continue;
    if (sample.netEvidence === 'suspect') continue;
    const hour = utcHourOfDay(sample.hourStartMs);
    byHour.set(hour, [...(byHour.get(hour) ?? []), sample]);
    latestMs = Math.max(latestMs, sample.hourStartMs);
  }
  for (const [hour, bucket] of byHour) {
    const factor = learnHourFactor(bucket, gainKwhPerWm2, latestMs);
    if (factor !== undefined) shape.set(hour, factor);
  }
  return shape;
};

/** The factor for an hour: its learned value, or 1 while that hour is unlearned. */
export const pvHourShapeFactor = (shape: PvHourShape, hourStartMs: number): number => (
  shape.get(utcHourOfDay(hourStartMs)) ?? 1
);
