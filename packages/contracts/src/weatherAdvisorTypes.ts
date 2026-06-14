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
   * Opt-in: at each daily rollup, apply the suggested daily budget to the
   * configured daily budget. No-op when the daily budget feature is off (the UI
   * shows a hint to turn it on). Absent ⇒ false (advisory-only, the default).
   */
  autoApplyDailyBudget?: boolean;
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
  /**
   * kWh sourced from the validated meter-Insights backfill, not the tracker.
   * Producer-internal bookkeeping for the kWh reconcile (it decides which
   * values may be re-resolved or stripped) — consumers must not branch on it.
   */
  kwhBackfilled?: boolean;
};

/**
 * Evidence that PELS itself suppressed this day's consumption, so the measured
 * daily kWh is a censored lower bound on true demand. Recorded at rollup from
 * the diagnostics + smart-task history (absent on backfilled days — diagnostics
 * don't reach that far back; absent therefore means "unknown", admitted as
 * unsuppressed). Producer-internal: consumers must not branch on it — the fit
 * and suggestion resolve it to flat outputs.
 */
export type WeatherDaySuppression = {
  /** Σ ms managed temperature devices were held below their intended target. */
  targetDeficitMs?: number;
  /** Σ ms a device could not run because capacity was saturated. */
  blockedByHeadroomMs?: number;
  /** A deadline-bound smart task missed AND its plan saw the daily budget exhausted. */
  deadlineMissedToBudget?: boolean;
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
  /**
   * Un-sheddable (background + uncontrolled-heater) kWh for the day, from the
   * tracker's `uncontrolledDailyTotals`. PELS never suppresses it, so the
   * uncontrolled-vs-temp relationship is an uncensored weather signal — recorded
   * now for a future kWh-based censoring estimate. Absent on backfilled days.
   */
  kwhUncontrolled?: number;
  tempMeanC: number;
  tempMinC: number;
  tempMaxC: number;
  tempSampleCount: number;
  quality: WeatherDailyQuality;
  /** Producer-internal censoring evidence; consumers must not branch on it. See WeatherDaySuppression. */
  suppression?: WeatherDaySuppression;
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

/**
 * One hub-local calendar day of MET Norway forecast aggregates. `meanTempC` is a
 * SIMPLE per-hour arithmetic mean (the only value that feeds the kWh prediction;
 * same estimator the fit trains on); min/max/evening are display/verdict context
 * and symbol/precip are display-only. Producer-internal: consumers read it only
 * via the resolved suggestion/prediction fields.
 */
export type MetDaySummary = {
  /** Hub-local calendar day (YYYY-MM-DD) this summary describes. */
  dateKey: string;
  /**
   * Simple per-hour arithmetic mean of this day's hourly air_temperature — the
   * ONLY value that enters the kWh prediction (same aggregate the fit trains on).
   */
  meanTempC: number;
  minTempC: number;
  maxTempC: number;
  /** Evening (local 17:00–23:00) aggregates; undefined when no evening hours landed. */
  eveningMinTempC?: number;
  eveningMeanTempC?: number;
  /** Display-only weather glyph; never fed to the fit. */
  symbolCode?: string;
  /** Display-only total precipitation (mm); never fed to the fit. */
  precipMmTotal?: number;
  /** Hourly entries that fell in this day's bucket. */
  hourCount: number;
  /** This day had near-complete hourly coverage (vs only the 6-hourly tail). */
  fullDayCoverage: boolean;
};

/**
 * Cached MET Norway forecast — the persisted result of the direct fetch that
 * replaced the +24h forecast device. Holds a PER-LOCAL-DAY summary map so each
 * consumer reads the day it needs: the midnight auto-apply path reads the
 * just-started day (`byDay[todayKey]`) while the forward-looking readout card
 * reads tomorrow (`byDay[tomorrowKey]`). The HTTP caching validators (`expires`,
 * `lastModified`) gate the collector's refetch per MET ToS. Producer-internal:
 * consumers read it only via the resolved suggestion/prediction fields.
 */
export type WeatherMetForecastCache = {
  /** Hub-local dateKey (YYYY-MM-DD) → that day's MET summary. Holds today + tomorrow. */
  byDay: Record<string, MetDaySummary>;
  fetchedAtMs: number;
  /** HTTP `Expires` header — refetch is skipped while still in the future. */
  expires?: string;
  /** HTTP `Last-Modified` header — sent as `If-Modified-Since` to enable 304 reuse. */
  lastModified?: string;
};

export type WeatherHistoryState = {
  /** Ascending by dateKey; pruned to the retention window. */
  records: WeatherDailyRecord[];
  /** dateKey → in-progress accumulation (today, plus yesterday until rollup). */
  accumulators?: Record<string, WeatherDayAccumulator>;
  /**
   * Cached MET forecast summary for tomorrow. The mean-consumers read it for the
   * coming-day temperature; refreshed by the collector honoring `Expires`.
   */
  metForecast?: WeatherMetForecastCache;
  /**
   * Forecast target dateKey → local hour ("00".."23") → °C. Legacy +24h-device
   * profile; no longer written or consumed (MET replaced it). Kept readable for
   * BC so a state persisted by an older version still normalizes (the value is
   * dropped after the next rollup). @deprecated never read; do not reintroduce.
   */
  forecastHourly?: Record<string, Record<string, number>>;
  /** Device id the one-shot Insights backfill last completed for. */
  backfilledDeviceId?: string;
  /** Stitch-set version the temperature backfill last completed with; bumping it re-runs the backfill. */
  backfillVersion?: number;
  /** Set once the validated meter-Insights kWh backfill completed. */
  meterKwhBackfillDone?: boolean;
  /** Meter device that passed the tracker-overlap validation. */
  meterKwhDeviceId?: string;
  /**
   * One-shot purge of kWh written by the retired (unvalidated) Energy-report
   * source. Once stamped, reconciles only fill and refresh — values that age
   * beyond every source's reach are kept, never stripped. Producer-internal.
   */
  kwhPurgeVersion?: number;
  /**
   * Version of the controlled/uncontrolled split backfill (summed managed-device
   * meters) last applied to historical records. Bumping it re-runs the split
   * fill; cleared with the meter markers on a device switch. Producer-internal.
   */
  controlledBackfillVersion?: number;
  /** Derived after each rollup/backfill; recomputed from records, never hand-edited. */
  latestFit?: EnergySignatureFit;
  latestSuggestion?: EnergySignatureSuggestion;
  /**
   * Audit of the last auto-applied daily budget (set only when auto-apply is on
   * and a suggestion was applied at a rollup). Drives the "Last applied" line in
   * the Settings sub-page. Producer-internal — consumers read it as flat values.
   */
  lastAutoApply?: { dateKey: string; kwh: number; appliedAtMs: number };
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
  /** Days dropped from the fit because PELS censored them (deadline-miss-to-budget). */
  suppressedDaysExcluded: number;
  /** Suppression exclusion would have starved the fit, so it was kept unfiltered (estimate may read low). */
  suppressionFilterRelaxed: boolean;
  /** Recent cold days showed comfort/capacity suppression — the suggestion leans up on a cold forecast. */
  recentColdSuppressionSuspected: boolean;
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
  /**
   * Where the coming-day mean came from. `met_api` is the direct MET Norway
   * fetch; `recent_days` is the trailing-week persistence fallback (MET
   * unavailable, partial, or no hub geolocation).
   */
  forecastSource: 'met_api' | 'recent_days';
  predictedKwh: number;
  predictedLowKwh: number;
  predictedHighKwh: number;
  /** Suggested daily budget — display-only unless the user opts into auto-apply. */
  suggestedBudgetKwh: number;
  /** Forecast colder than any observed day; evaluated at the coldest observed instead. */
  beyondObservedCold: boolean;
  /** Forecast warmer than any observed day; evaluated at the warmest observed instead. */
  beyondObservedWarm: boolean;
  /** Recent cold days were PELS-limited and tomorrow is cold — the suggestion was leaned up. */
  budgetMayBeLimiting: boolean;
  /** Tomorrow's forecast low (°C), when the MET summary supplied it — display context only. */
  tempMinC?: number;
  /** Tomorrow's forecast high (°C), when the MET summary supplied it — display context only. */
  tempMaxC?: number;
  /**
   * Producer-resolved verdict context: tomorrow's evening genuinely swings cold
   * (evening below the fit's balance point while the day mean is at/above it).
   * Display/verdict only — never enters the kWh number.
   */
  coldEveningSuspected?: boolean;
  computedAtMs: number;
};

// ── Settings-UI readout ─────────────────────────────────────────────────────
//
// Server-assembled payload for the hidden "Weather insight" surface
// (`/ui_weather_advisor_readout`). The runtime resolves everything to flat
// values — state, device names, decimated scatter — so the UI never re-derives
// from raw records (resolution-in-producer rule). `null` from the endpoint
// means the feature flag is off (structural absence in the UI).

export type WeatherAdvisorReadoutState = 'needs_device' | 'backfilling' | 'learning' | 'ready' | 'error';

export type WeatherAdvisorSettingsEcho = {
  outdoorDeviceId: string | null;
  outdoorDeviceName: string | null;
};

/** 5 °C coverage bin; `sufficient` = ≥ 14 usable days (the solid shade). */
export type WeatherCoverageBin = {
  fromC: number;
  toC: number;
  days: number;
  sufficient: boolean;
};

/** 1 °C scatter bin — the count-weighted symbols the chart renders. */
export type WeatherScatterBin = {
  tempBinC: number;
  kwhMedian: number;
  kwhQ1: number;
  kwhQ3: number;
  count: number;
};

/** One raw recent day (≤ 90 shipped) for the accent overlay + tooltips. */
export type WeatherRecentDay = {
  dateKey: string;
  tempMeanC: number;
  kwhTotal: number;
  quality: WeatherDailyQuality;
};

/**
 * Producer-resolved forecast provenance for honest copy. `forecast` = MET Norway
 * provided tomorrow's full forward profile; `recent_days` = MET was unavailable,
 * partial, or no hub geolocation, so the prediction falls back to the trailing
 * week of observed days. Resolved once at the payload level so every state (incl.
 * learning, where there is no prediction) shares one answer; consumers map it
 * straight to copy and never re-derive it from settings (resolution-in-producer).
 */
export type WeatherForecastStatus = 'forecast' | 'recent_days';

/**
 * Live reading of a configured device, resolved by the producer so the Settings
 * pickers can confirm a chosen device actually works the instant it's picked.
 * `reading` carries the current value; `unreadable` = configured but PELS can't
 * read a temperature (wrong device, sub-capability-only, dead sensor, transient);
 * `no_device` = nothing configured (the picker shows its hint, no status line).
 */
export type WeatherDeviceReading =
  | { status: 'reading'; tempC: number }
  | { status: 'unreadable' }
  | { status: 'no_device' };

export type WeatherAdvisorPrediction = {
  tempMeanC: number;
  /** Tomorrow's forecast low (°C); set only when the MET summary supplied it. */
  tempMinC?: number;
  /** Tomorrow's forecast high (°C); set only when the MET summary supplied it. */
  tempMaxC?: number;
  kwh: number;
  /** q10 of the expected range. */
  lowKwh: number;
  /** q90 of the expected range. */
  highKwh: number;
  beyondObservedCold: boolean;
  beyondObservedWarm: boolean;
};

export type WeatherAdvisorSuggestion = {
  /** Suggested daily budget. Display-only unless auto-apply is on; `Adjust budget` opens unprefilled. */
  kwh: number;
  /** The active daily budget for comparison; null when the daily budget is off. */
  currentDailyBudgetKwh: number | null;
  /** Tomorrow's expected usage exceeds what the hard cap delivers in a day (cap × 24 h). */
  cappedByCapacity: boolean;
  /** Recent cold days were PELS-limited and tomorrow is cold — the suggestion was raised to match. */
  budgetMayBeLimiting: boolean;
  /** Tomorrow swings genuinely cold in the evening — chooses the cold-evening verdict clause. */
  coldEveningSuspected?: boolean;
};

/** Yesterday vs typical-for-its-temperature, resolved server-side. */
export type WeatherAdvisorYesterday = {
  dateKey: string;
  tempMeanC: number;
  kwhTotal: number;
  /** kWh above (+) / below (−) typical for the day's temperature; null when no anchor. */
  deviationKwh: number | null;
};

export type WeatherAdvisorReadoutPayload = {
  state: WeatherAdvisorReadoutState;
  /** Orthogonal to `state`: recent days run above typical (S6 treatment). */
  driftSuspected: boolean;
  /** Median kWh/day recent days run above typical; set only while drift is suspected. */
  driftDeviationKwh: number | null;
  settings: WeatherAdvisorSettingsEcho;
  /** Forecast provenance, resolved for every state so copy is honest with or without a prediction. */
  forecastStatus: WeatherForecastStatus;
  /** Live outdoor-device reading for the Settings picker validity line. */
  outdoorReading: WeatherDeviceReading;
  /** Active daily budget (kWh); null when disabled — drives the setup card's budget hint. */
  dailyBudgetKwh: number | null;
  /** Whether the daily budget feature is on — gates the auto-apply inert hint. */
  dailyBudgetEnabled: boolean;
  /** Whether auto-apply of the suggested daily budget is enabled. */
  autoApplyDailyBudget: boolean;
  /** Last auto-applied budget (date + kWh) for the "Last applied" line; null when never applied. */
  lastAutoApply: { dateKey: string; kwh: number } | null;
  fit: EnergySignatureFit | null;
  coverage: WeatherCoverageBin[];
  prediction: WeatherAdvisorPrediction | null;
  suggestion: WeatherAdvisorSuggestion | null;
  scatter: WeatherScatterBin[];
  recentDays: WeatherRecentDay[];
  yesterday: WeatherAdvisorYesterday | null;
  /** Days currently usable by the estimate — drives the learning-state copy. */
  usableDays: number;
  /** Usable days reconstructed by the Insights backfill (footnote wording). */
  backfilledDays: number;
  /** Days left out of the estimate because the budget limited them (footnote wording). */
  suppressedDaysExcluded: number;
  generatedAtMs: number;
};
