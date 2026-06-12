/**
 * Wire types for the hidden weather-insight feature: per-day usage/outdoor-
 * temperature history collected by the runtime (`lib/weather/**`) and later
 * consumed by the settings UI. Browser-safe: types only, no runtime imports.
 */

export type WeatherAdvisorSettings = {
  enabled: boolean;
  /** Device whose `measure_temperature` reports the current outdoor temperature. */
  outdoorDeviceId?: string;
  /**
   * Optional device reporting the forecast temperature ~24 h ahead (a yr.no
   * device configured with `period: 24`). Sampled hourly, its readings build
   * tomorrow's hourly temperature profile incrementally across today.
   */
  forecastDeviceId?: string;
};

export type WeatherDailyQuality = {
  /** Too few temperature samples landed to trust the daily mean. */
  partialTemp: boolean;
  /** No daily kWh total was available when the day was rolled up. */
  missingKwh: boolean;
  /** Power measurement had gaps (>1 h) somewhere inside this local day. */
  unreliablePower: boolean;
  /** Reconstructed from Homey Insights history rather than live sampling. */
  backfilled: boolean;
};

/**
 * One local calendar day of joined usage + outdoor temperature. kWh values are
 * snapshotted at day close so the record stays self-contained after the power
 * tracker prunes its own history.
 */
export type WeatherDailyRecord = {
  /** YYYY-MM-DD in the Homey's local timezone. */
  dateKey: string;
  kwhTotal?: number;
  kwhControlled?: number;
  tempMeanC: number;
  tempMinC: number;
  tempMaxC: number;
  tempSampleCount: number;
  quality: WeatherDailyQuality;
};

/** In-progress accumulation for a day that has not been rolled up yet. */
export type WeatherDayAccumulator = {
  sumC: number;
  count: number;
  minC: number;
  maxC: number;
  /** Local hour ("00".."23") of the last accumulated sample — dedupes within-hour samples. */
  lastHourKey?: string;
};

export type WeatherHistoryState = {
  /** Ascending by dateKey; pruned to the retention window. */
  records: WeatherDailyRecord[];
  /** dateKey → in-progress accumulation (today, plus yesterday until rollup). */
  accumulators?: Record<string, WeatherDayAccumulator>;
  /** Forecast target dateKey → local hour ("00".."23") → °C. Only near-future dateKeys are kept. */
  forecastHourly?: Record<string, Record<string, number>>;
  /** Device id the one-shot Insights backfill last completed for. */
  backfilledDeviceId?: string;
  /** Derived after each rollup/backfill; recomputed from records, never hand-edited. */
  latestFit?: EnergySignatureFit;
  latestSuggestion?: EnergySignatureSuggestion;
};

/**
 * Which shape the usage/temperature relationship resolved to:
 * - `changepoint`: heating-degree model with an identified balance point —
 *   flat base load above it, linear rise below it.
 * - `linear`: slope is trustworthy but the data never spans warm days
 *   (winter-only), so the balance point and base load are not identifiable.
 * - `uncorrelated`: colder days don't use noticeably more energy — a valid,
 *   honest outcome (e.g. non-electric heating), not a failure.
 */
export type EnergySignatureModel = 'changepoint' | 'linear' | 'uncorrelated';

export type EnergySignatureConfidence = 'learning' | 'low' | 'medium' | 'high';

export type EnergySignatureFit = {
  model: EnergySignatureModel;
  /** Flat-segment usage (kWh/day) above the balance point; `changepoint` only. */
  baseLoadKwhPerDay?: number;
  /** Predicted kWh/day at 0 °C; `linear` only (no identifiable balance point). */
  interceptKwhAtZeroC?: number;
  /** Extra kWh per °C colder day — the headline "temperature sensitivity". */
  slopeKwhPerDegree: number;
  /** Sen's nonparametric 95% interval on the slope. */
  slopeCiLow?: number;
  slopeCiHigh?: number;
  balancePointC?: number;
  /** L1 pseudo-R²: 1 − Σ|residual| / Σ|deviation from median|. */
  pseudoR2: number;
  usableDays: number;
  observedTempMinC: number;
  observedTempMaxC: number;
  /** Median usable-day consumption — the prediction anchor when `uncorrelated`. */
  medianDayKwh: number;
  /** 5th percentile of observed usable days — the suggestion's hard floor. */
  lowObservedDayKwh: number;
  confidence: EnergySignatureConfidence;
  /** Cold-half slope ≥30% steeper than warm-half — typical for heat pumps. */
  curvatureSteeperWhenCold: boolean;
  /**
   * Envelope-loss ballpark derived from the slope (×1000/24). Only honest for
   * directly electric-heated homes without wood stoves; UI must caveat it and
   * never headline it.
   */
  heatLossWPerK?: number;
  /** Recent days run above what's typical for their temperature. */
  driftSuspected: boolean;
  residualQ10: number;
  residualQ50: number;
  residualQ80: number;
  residualQ90: number;
  fittedAtMs: number;
};

export type EnergySignatureSuggestion = {
  /** Local day the suggestion targets — at the midnight recompute this is the just-started day. */
  targetDateKey: string;
  forecastMeanTempC: number;
  forecastSource: 'forecast_device' | 'recent_days';
  predictedKwh: number;
  predictedLowKwh: number;
  predictedHighKwh: number;
  /** Advisory only — never auto-applied to the daily budget. */
  suggestedBudgetKwh: number;
  /** Forecast colder than any observed day; evaluated at the coldest observed instead. */
  beyondObservedCold: boolean;
  /** Forecast warmer than any observed day; evaluated at the warmest observed instead. */
  beyondObservedWarm: boolean;
  computedAtMs: number;
};
