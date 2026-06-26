// Clear-sky solar model — the deterministic SHAPE of a sunny-day generation curve.
//
// Pure, browser-safe geometry: given a location (lat/lon) and an instant, it
// returns the theoretical clear-sky global horizontal irradiance (GHI, W/m²) —
// the diurnal + seasonal envelope a PV array would see under a cloudless sky.
//
// It is intentionally absolute-scale-agnostic for PELS's purposes: the learned
// PV gain (fit from recorded generation) and the MET cloud attenuation are layered
// on top downstream. This module owns ONLY the sun's geometry and a standard
// clear-sky transmittance; it knows nothing about panels, clouds, or the SDK.
//
// Model: Cooper declination + the classic equation-of-time, solar elevation from
// spherical trig, and the Haurwitz clear-sky GHI (a well-established single-
// parameter model: GHI = 1098·cos(z)·exp(−0.059/cos(z))). Accuracy is ample for a
// forecast whose absolute scale is calibrated away by a learned gain.

const DEG = Math.PI / 180;
const HAURWITZ_A = 1098; // W/m²
const HAURWITZ_B = 0.059;

const MS_PER_DAY = 86_400_000;
const MS_PER_HALF_HOUR = 1_800_000;

/** Day of year (1..366), UTC, for an epoch-ms instant. */
export const dayOfYearUtc = (ms: number): number => {
  const d = new Date(ms);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((ms - yearStart) / MS_PER_DAY);
};

/** Fractional hour of the UTC day (0..24). Forecast instants are non-negative. */
const utcHourOfDay = (ms: number): number => (ms % MS_PER_DAY) / 3_600_000;

/** Solar declination (radians) — Cooper's equation. Ranges ±23.45° over the year. */
export const solarDeclinationRad = (dayOfYear: number): number => (
  23.45 * DEG * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365)
);

/** Equation of time (minutes) — apparent-vs-mean solar time correction. */
export const equationOfTimeMin = (dayOfYear: number): number => {
  const b = ((2 * Math.PI) / 364) * (dayOfYear - 81);
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
};

/**
 * Sine of the solar elevation angle (= cos of the solar zenith) for a location
 * and instant. Negative when the sun is below the horizon. Longitude is degrees
 * east (positive); the calculation runs in true solar time, so it is timezone-free.
 */
export const sinSolarElevation = (latDeg: number, lonDeg: number, ms: number): number => {
  const n = dayOfYearUtc(ms);
  const decl = solarDeclinationRad(n);
  const trueSolarHour = utcHourOfDay(ms) + lonDeg / 15 + equationOfTimeMin(n) / 60;
  const hourAngle = 15 * DEG * (trueSolarHour - 12);
  const lat = latDeg * DEG;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  return Math.max(-1, Math.min(1, sinEl));
};

/**
 * Clear-sky global horizontal irradiance (W/m²) for a location and instant.
 * Zero whenever the sun is at or below the horizon (Haurwitz, by construction).
 */
export const clearSkyGhiWm2 = (latDeg: number, lonDeg: number, ms: number): number => {
  const cosZenith = sinSolarElevation(latDeg, lonDeg, ms);
  if (cosZenith <= 0) return 0;
  return HAURWITZ_A * cosZenith * Math.exp(-HAURWITZ_B / cosZenith);
};

/**
 * Clear-sky GHI (W/m²) for a series of hour-start instants, each sampled at the
 * hour's midpoint so the value represents the whole hour rather than its leading
 * edge. The array order is preserved — the producer pairs it with forecast hours.
 */
export const clearSkyGhiHourly = (
  latDeg: number,
  lonDeg: number,
  hourStartsMs: readonly number[],
): number[] => hourStartsMs.map((ms) => clearSkyGhiWm2(latDeg, lonDeg, ms + MS_PER_HALF_HOUR));
