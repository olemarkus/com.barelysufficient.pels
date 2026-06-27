// Learned PV gain — "what does THIS roof produce per unit of irradiance it saw".
//
// The forecast uses direct shortwave irradiance (W/m², from Open-Meteo), which
// already integrates sun angle, season, AND cloud cover into one physical number —
// so there is no clear-sky model or cloud-attenuation guess to get wrong. The one
// thing PELS cannot know a priori is the device's effective gain: panel area ×
// efficiency × orientation × inverter losses (and the average temperature derate)
// rolled into a single kWh-per-(W/m²) constant. This module LEARNS that gain
// robustly from recorded (irradiance, measured-generation) hours — no panel-spec
// config needed.
//
// gain_h estimate = generation_h / irradiance_h; the learned gain is the MEDIAN
// over training hours (robust to the odd shaded/soiled/clipped hour). Browser-safe.

export type PvGainTrainingPoint = {
  /** Shortwave irradiance the panels received for the hour (W/m²). */
  irradianceWm2: number;
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

// Below this irradiance the hour is too dim to learn from (dawn/dusk/deep
// overcast): a tiny denominator amplifies measurement noise into the gain.
const MIN_IRRADIANCE_WM2 = 50;

/** Minimum trained hours before a gain is returned at all (≈ a few daylight days). */
export const MIN_PV_GAIN_SAMPLES = 24;

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
 * hour contributes `generation / irradiance`; the gain is their median.
 */
export const fitPvGain = (points: readonly PvGainTrainingPoint[]): PvGainFit | null => {
  const gains: number[] = [];
  for (const point of points) {
    // `!finite` must short-circuit: a NaN irradiance would make `NaN < floor` false
    // and slip a NaN ratio into the median, poisoning the whole gain.
    if (!Number.isFinite(point.irradianceWm2) || point.irradianceWm2 < MIN_IRRADIANCE_WM2) continue;
    if (!Number.isFinite(point.generationKwh) || point.generationKwh < 0) continue;
    gains.push(point.generationKwh / point.irradianceWm2);
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
