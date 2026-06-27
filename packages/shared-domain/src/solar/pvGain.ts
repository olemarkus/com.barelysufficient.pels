// Learned PV gain — "what does THIS roof produce per unit of sun it actually saw".
//
// The clear-sky model (clearSky.ts) gives the cloudless-sky irradiance shape; MET
// cloud cover attenuates it to the irradiance the panels actually received. The one
// thing PELS cannot know a priori is the device's effective gain — panel area ×
// efficiency × orientation × inverter losses, all rolled into a single
// kWh-per-(W/m²) constant. This module LEARNS that gain robustly from recorded
// (clear-sky, cloud, measured-generation) hours, so no panel-spec config is needed.
//
// gain_h estimate = generation_h / (clearSky_h × clearness_h); the learned gain is
// the MEDIAN over training hours (robust to the odd shaded/soiled/clipped hour).
// Browser-safe: arithmetic only.

export type PvGainTrainingPoint = {
  /** Clear-sky GHI for the hour (W/m², from the clear-sky model). */
  clearSkyWm2: number;
  /** MET cloud cover for the hour, 0 (clear) .. 1 (overcast). */
  cloudFraction: number;
  /** Measured generation energy for the hour (kWh). */
  generationKwh: number;
};

export type PvGainConfidence = 'low' | 'medium' | 'high';

export type PvGainFit = {
  /** Learned device gain in kWh per (W/m²·hour). */
  gainKwhPerWm2: number;
  /** Hours that passed the irradiance floor and fed the fit. */
  sampleCount: number;
  /** Median absolute deviation of per-hour gains / gain — dimensionless scatter. */
  relativeScatter: number;
  confidence: PvGainConfidence;
};

// Below this effective irradiance the clear-sky term is too small to learn from
// (dawn/dusk/overcast): a tiny denominator amplifies measurement noise into the gain.
const MIN_EFFECTIVE_WM2 = 50;

/** Minimum trained hours before a gain is returned at all (≈ a few daylight days). */
export const MIN_PV_GAIN_SAMPLES = 24;

/** Fraction of clear-sky irradiance reaching the panels: 1 (clear) .. 0 (overcast). */
export const clearnessFactor = (cloudFraction: number): number => {
  const clamped = Number.isFinite(cloudFraction) ? Math.min(1, Math.max(0, cloudFraction)) : 1;
  return 1 - clamped;
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const resolveConfidence = (sampleCount: number, relativeScatter: number): PvGainConfidence => {
  if (sampleCount >= 168 && relativeScatter <= 0.15) return 'high';
  if (sampleCount >= 72 && relativeScatter <= 0.25) return 'medium';
  return 'low';
};

/**
 * Fit the device's PV gain from recorded hours, or `null` while still learning
 * (fewer than `MIN_PV_GAIN_SAMPLES` hours clear the irradiance floor). Each usable
 * hour contributes `generation / (clearSky × clearness)`; the gain is their median.
 */
export const fitPvGain = (points: readonly PvGainTrainingPoint[]): PvGainFit | null => {
  const gains: number[] = [];
  for (const point of points) {
    const effectiveWm2 = Math.max(0, point.clearSkyWm2) * clearnessFactor(point.cloudFraction);
    // `!finite` must short-circuit: a NaN clearSky would make `NaN < floor` false and
    // slip a NaN ratio into the median, poisoning the whole gain.
    if (!Number.isFinite(effectiveWm2) || effectiveWm2 < MIN_EFFECTIVE_WM2) continue;
    if (!Number.isFinite(point.generationKwh) || point.generationKwh < 0) continue;
    gains.push(point.generationKwh / effectiveWm2);
  }
  if (gains.length < MIN_PV_GAIN_SAMPLES) return null;

  const gain = median(gains);
  if (!Number.isFinite(gain) || gain <= 0) return null;
  const mad = median(gains.map((g) => Math.abs(g - gain)));
  const relativeScatter = mad / gain;
  return {
    gainKwhPerWm2: gain,
    sampleCount: gains.length,
    relativeScatter,
    confidence: resolveConfidence(gains.length, relativeScatter),
  };
};
