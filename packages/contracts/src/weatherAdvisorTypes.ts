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
};
