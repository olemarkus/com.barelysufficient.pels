import type {
  EnergySignatureConfidence,
  EnergySignatureFit,
  EnergySignatureModel,
  WeatherDailyRecord,
} from '../../../contracts/src/weatherAdvisorTypes';
import { dayWasBudgetDamaged } from './budgetPressure';

/**
 * Robust "energy signature" fit: daily kWh against daily mean outdoor
 * temperature, using a heating-degree change-point model with Theil–Sen
 * estimation. Browser-safe and dependency-free so the settings UI can reuse
 * the exact runtime math.
 *
 * Estimator choices (see the weather-insight plan for the full rationale):
 * - Theil–Sen (29% breakdown) because guests, wood-stove evenings, and empty
 *   houses are systematic outliers, not Gaussian noise.
 * - Balance point fitted over a coarse τ grid, degenerating to a plain linear
 *   fit when the data never spans warm days (winter-only onboarding).
 * - L1 pseudo-R² and rank-based Sen confidence intervals — consistent with
 *   the robust loss; no math libraries needed.
 * - No 23/25-hour DST day-length normalization: at most two days a year
 *   deviate by ±4%, which cannot move a median-based fit over ≥21 days.
 * - An optional season term on top of the change-point: at the same mean
 *   temperature a home uses more in the dark half of the year (lighting, time
 *   indoors, little solar gain). It is a fixed cosine of the day of year that
 *   peaks at the December solstice, so only its size is learned and no latitude
 *   is needed; a southern-hemisphere home simply learns a negative size. It is
 *   fitted by alternating Theil–Sen passes and kept only when the history spans
 *   both halves of the year and the term clearly lowers the fit's error.
 */

const MIN_USABLE_DAYS = 21;
/**
 * Fit on the trailing usable-day year. A full seasonal cycle is what makes
 * the balance point identifiable at all — a summer-only window has no heating
 * regime — and the Insights backfills exist precisely to hand a new install a
 * year of pairs on day one. Occupancy/equipment changes inside the window are
 * surfaced by the drift detector rather than by truncating the window.
 */
const FIT_WINDOW_DAYS = 365;
const BALANCE_POINT_GRID_C = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
/** Loss spread below this fraction across the τ grid ⇒ τ is not identifiable. */
const CHANGEPOINT_DEGENERACY_SPREAD = 0.02;
const DRIFT_RECENT_DAYS = 14;
const CURVATURE_MIN_DAYS_PER_HALF = 10;
const CURVATURE_STEEPER_FACTOR = 1.3;
/**
 * A τ is only identifiable when some usable days sit ABOVE it: with a
 * winter-only window every τ ≥ max(T) yields an identical loss (the hinge
 * never clamps), and the grid would fabricate the lowest tied τ as a
 * confident balance point with a base load biased high.
 */
const MIN_DAYS_ABOVE_BALANCE = 5;
/** 97.5th normal quantile for Sen's 95% slope interval. */
const SEN_CI_Z = 1.96;
/** Month (0-based) and day of the December solstice, where the season index peaks at +1. */
const SEASON_PEAK_MONTH = 11;
const SEASON_PEAK_DAY = 21;
const DAYS_PER_YEAR = 365.25;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A season index at least this far from 0 places a day in the dark or light half of the year. */
const SEASON_SIDE_THRESHOLD = 0.5;
/** Days needed in each half of the year before the season term is identifiable. */
const SEASON_MIN_DAYS_PER_SIDE = 20;
/** Season/change-point passes; the second leaves real histories within 0.1 kWh/day of the converged fit. */
const SEASON_BACKFIT_ROUNDS = 2;
/** The season term must cut the fit's total absolute error by at least this fraction to be kept. */
const SEASON_MIN_LOSS_REDUCTION = 0.05;

type FitDay = { tempC: number; kwh: number; season: number };

/** `sortedSlopes`: every pairwise slope in ascending order, for Sen's interval. */
type RobustLine = { slope: number; intercept: number; sortedSlopes: Float64Array };

/**
 * A day whose measured kWh is a censored lower bound on demand strong enough to
 * exclude from the fit. v1 trusts ONLY the unambiguous signal: a deadline-bound
 * smart task that missed BECAUSE the daily budget ran out. Daily-budget
 * censoring is recorded too but only drives the suggestion's upward corrections
 * (`dayWasBudgetDamaged`) — excluding those days from the fit is itself
 * slope-flattening, and on real data it moves the suggestion the WRONG way,
 * because the days a home is held back on are its high-demand days.
 */
const isMateriallySuppressed = (record: WeatherDailyRecord): boolean => (
  record.suppression?.deadlineMissedToBudget === true
);

type FitSelection = {
  records: WeatherDailyRecord[];
  suppressedDaysExcluded: number;
  suppressionFilterRelaxed: boolean;
};

/**
 * Quality-usable days the fit runs on: drop materially-suppressed days, but if
 * doing so would starve the fit below the minimum, keep them and flag the fit
 * as relaxed (a biased-but-present estimate plus an honest warning beats no
 * estimate). Windowing happens after both filters so a flaky stretch never
 * shrinks the sample below the gate.
 */
function selectFitRecords(records: WeatherDailyRecord[]): FitSelection {
  // Window on quality days FIRST so the fit's date span stays stable, then drop
  // materially-suppressed days from WITHIN that window — the exclusion count is
  // then exactly the suppressed days inside the window, regardless of where they
  // fall (a burst of cold suppressed days must not slide the window backwards).
  const windowedQuality = records.filter((record) => isUsableSignatureDay(record)).slice(-FIT_WINDOW_DAYS);
  const kept = windowedQuality.filter((record) => !isMateriallySuppressed(record));
  const suppressedInWindow = windowedQuality.length - kept.length;
  const useFiltered = kept.length >= MIN_USABLE_DAYS;
  return {
    records: useFiltered ? kept : windowedQuality,
    suppressedDaysExcluded: useFiltered ? suppressedInWindow : 0,
    suppressionFilterRelaxed: !useFiltered && suppressedInWindow > 0,
  };
}

/**
 * Recent days the DAILY BUDGET damaged — the suggestion then leans up.
 *
 * Only unresolved, budget-attributed shortfall enables the more generous
 * quantile. Cumulative historical holds cannot establish that outcome.
 */
function detectRecentSuppression(records: WeatherDailyRecord[]): boolean {
  return records
    .filter((record) => isUsableSignatureDay(record))
    .slice(-DRIFT_RECENT_DAYS)
    .some(dayWasBudgetDamaged);
}

export function fitEnergySignature(records: WeatherDailyRecord[], nowMs: number): EnergySignatureFit | null {
  const selection = selectFitRecords(records);
  if (selection.records.length < MIN_USABLE_DAYS) return null;
  const usable: FitDay[] = selection.records.map((record) => ({
    tempC: record.tempMeanC,
    kwh: record.kwhTotal as number,
    season: seasonIndexForDateKey(record.dateKey),
  }));

  const temps = usable.map((day) => day.tempC);
  const kwhs = usable.map((day) => day.kwh);
  const observedTempMinC = Math.min(...temps);
  const observedTempMaxC = Math.max(...temps);
  const medianDayKwh = median(kwhs);
  const lowObservedDayKwh = quantile(kwhs, 0.05);

  const { model, line, balancePointC, seasonKwh } = resolveModel(usable);
  const seasonOf = (day: FitDay): number => (seasonKwh ?? 0) * day.season;
  const residuals = usable.map((day) => (
    day.kwh - predictWithLine(model, line, balancePointC, day.tempC) - seasonOf(day)
  ));
  // The annual model captures seasons; recent residuals capture occupancy/load changes.
  const recentResiduals = residuals.slice(-DRIFT_RECENT_DAYS);
  const pseudoR2 = pseudoR2L1(kwhs, residuals);
  const ci = senSlopeInterval(line.sortedSlopes, usable.length);
  const driftSuspected = detectDrift(residuals);
  const confidence = resolveConfidence({
    model, usableDays: usable.length, temps, pseudoR2, slope: line.slope, ci, driftSuspected,
  });
  const recentSuppressionSuspected = detectRecentSuppression(records);

  return {
    model,
    ...(model === 'changepoint' ? { baseLoadKwhPerDay: line.intercept, balancePointC } : {}),
    ...(model === 'linear' ? { interceptKwhAtZeroC: line.intercept } : {}),
    ...(seasonKwh !== undefined ? { seasonKwh } : {}),
    slopeKwhPerDegree: line.slope,
    ...(ci ? { slopeCiLow: ci.low, slopeCiHigh: ci.high } : {}),
    recentResidualQ80: quantile(recentResiduals, 0.8),
    recentResidualQ90: quantile(recentResiduals, 0.9),
    pseudoR2,
    usableDays: usable.length,
    observedTempMinC,
    observedTempMaxC,
    medianDayKwh,
    lowObservedDayKwh,
    confidence,
    // Curvature is judged on the temperature response alone, with the season
    // term taken out — otherwise dark-season days would read as a steeper cold half.
    curvatureSteeperWhenCold: model !== 'uncorrelated' && detectColdCurvature(
      usable.map((day) => ({ ...day, kwh: day.kwh - seasonOf(day) })),
      balancePointC,
    ),
    ...(model !== 'uncorrelated' ? { heatLossWPerK: (line.slope * 1000) / 24 } : {}),
    driftSuspected,
    suppressedDaysExcluded: selection.suppressedDaysExcluded,
    suppressionFilterRelaxed: selection.suppressionFilterRelaxed,
    recentSuppressionSuspected,
    residualQ10: quantile(residuals, 0.1),
    residualQ50: quantile(residuals, 0.5),
    residualQ80: quantile(residuals, 0.8),
    residualQ90: quantile(residuals, 0.9),
    fittedAtMs: nowMs,
  };
}

/**
 * Where a local day sits in the year: +1 at the December solstice, −1 at the
 * June solstice, ~0 at the equinoxes. Calendar arithmetic on the date key only,
 * so it is the same in every time zone and needs no location.
 */
export function seasonIndexForDateKey(dateKey: string): number {
  const dayMs = Date.parse(`${dateKey}T00:00:00Z`);
  const peakMs = Date.UTC(new Date(dayMs).getUTCFullYear(), SEASON_PEAK_MONTH, SEASON_PEAK_DAY);
  return Math.cos((2 * Math.PI * ((dayMs - peakMs) / DAY_MS)) / DAYS_PER_YEAR);
}

/** Usage above the balance point on the given local day: the base load moved by the season term. */
export function warmDayKwhFor(fit: EnergySignatureFit, dateKey: string): number {
  return (fit.baseLoadKwhPerDay ?? 0) + (fit.seasonKwh ?? 0) * seasonIndexForDateKey(dateKey);
}

/**
 * Expected kWh for the local day `dateKey` with the given mean temperature;
 * undefined when usage is uncorrelated.
 */
export function predictDailyKwh(fit: EnergySignatureFit, tempMeanC: number, dateKey: string): number | undefined {
  if (fit.model === 'uncorrelated') return undefined;
  if (fit.model === 'changepoint') {
    const balance = fit.balancePointC ?? 0;
    return warmDayKwhFor(fit, dateKey) + fit.slopeKwhPerDegree * Math.max(0, balance - tempMeanC);
  }
  return (fit.interceptKwhAtZeroC ?? 0) - fit.slopeKwhPerDegree * tempMeanC;
}

/**
 * Quality gate for a day to count toward the signature: clean temp + kWh,
 * reliable power, positive total. Net-export (PV) days carry no readable
 * heating signal; excluding them keeps negative totals from bending the
 * slope. Backfilled days are admitted — they are good data. Shared with the
 * settings-UI readout builder so the scatter/coverage decimation and the fit
 * judge days by the same gate.
 */
export function isUsableSignatureDay(record: WeatherDailyRecord): boolean {
  return !record.quality.partialTemp
    && !record.quality.missingKwh
    && !record.quality.unreliablePower
    && Number.isFinite(record.tempMeanC)
    && typeof record.kwhTotal === 'number'
    && Number.isFinite(record.kwhTotal)
    && record.kwhTotal > 0;
}

/** Days currently counting toward the fit (same gates + window the fit uses). */
export function countUsableDays(records: WeatherDailyRecord[]): number {
  return selectUsableDays(records).length;
}

function selectUsableDays(records: WeatherDailyRecord[]): WeatherDailyRecord[] {
  return records
    .filter((record) => isUsableSignatureDay(record))
    // Deliberately the trailing USABLE days, not calendar days: windowing
    // before the quality filter would shrink the sample after flaky stretches
    // and can drop the fit below the 21-day gate entirely. The drift detector
    // slices the same usable axis, so recency stays mutually consistent.
    .slice(-FIT_WINDOW_DAYS);
}

type ChangepointFit = { line: RobustLine; balancePointC: number };

function resolveModel(days: FitDay[]): {
  model: EnergySignatureModel;
  line: RobustLine;
  balancePointC?: number;
  seasonKwh?: number;
} {
  const changepoint = fitBestChangepoint(days);
  if (changepoint && changepoint.line.slope > 0) {
    const seasonal = fitSeasonalChangepoint(days, changepoint);
    if (seasonal) {
      return {
        model: 'changepoint',
        line: seasonal.fit.line,
        balancePointC: seasonal.fit.balancePointC,
        seasonKwh: seasonal.seasonKwh,
      };
    }
    return { model: 'changepoint', line: changepoint.line, balancePointC: changepoint.balancePointC };
  }
  // Winter-only data (or no usable change-point): fit kWh against −T so a
  // positive slope still reads "colder ⇒ more energy".
  const linear = theilSen(days.map((day) => ({ x: -day.tempC, y: day.kwh })));
  if (linear && linear.slope > 0) {
    return { model: 'linear', line: linear };
  }
  // Uncorrelated: anchor on the flat median-day line, NOT the rejected linear
  // fit — residual quantiles must be centered on the same anchor the budget
  // suggestion adds them to, and a rejected negative slope must not be
  // stamped into the contract's "kWh per °C colder" field.
  return {
    model: 'uncorrelated',
    line: { slope: 0, intercept: median(days.map((d) => d.kwh)), sortedSlopes: new Float64Array(0) },
  };
}

/**
 * Change-point plus season term, by alternating robust passes. Each pass
 * updates the season size from the change-point's residuals against the part
 * of the season index the heating term cannot already explain (cold days come
 * in winter, so the two overlap heavily and a plain residual regression would
 * creep toward the answer over dozens of passes), then refits the change-point,
 * balance point included, on usage with that season taken out. Null, so the
 * plain change-point stands, when the history does not cover both halves of the
 * year, when a pass loses the change-point, or when the term does not clearly
 * lower the total error.
 */
function fitSeasonalChangepoint(
  days: FitDay[],
  plain: ChangepointFit,
): { fit: ChangepointFit; seasonKwh: number } | null {
  const darkDays = days.filter((day) => day.season >= SEASON_SIDE_THRESHOLD).length;
  const lightDays = days.filter((day) => day.season <= -SEASON_SIDE_THRESHOLD).length;
  if (darkDays < SEASON_MIN_DAYS_PER_SIDE || lightDays < SEASON_MIN_DAYS_PER_SIDE) return null;
  let fit = plain;
  let seasonKwh = 0;
  for (let round = 0; round < SEASON_BACKFIT_ROUNDS; round += 1) {
    const current = fit;
    const heating = days.map((day) => Math.max(0, current.balancePointC - day.tempC));
    const seasonOnHeating = theilSen(days.map((day, index) => ({ x: heating[index] ?? 0, y: day.season })));
    if (!seasonOnHeating) return null;
    const size = seasonKwh;
    const step = theilSen(days.map((day, index) => ({
      x: day.season - seasonOnHeating.intercept - seasonOnHeating.slope * (heating[index] ?? 0),
      y: day.kwh - size * day.season - predictChangepoint(current, day.tempC),
    })));
    if (!step) return null;
    seasonKwh = size + step.slope;
    const adjusted = seasonKwh;
    const refit = fitBestChangepoint(days.map((day) => ({ ...day, kwh: day.kwh - adjusted * day.season })));
    if (!refit || refit.line.slope <= 0) return null;
    fit = refit;
  }
  const final = fit;
  const plainLoss = days.reduce((sum, day) => sum + Math.abs(day.kwh - predictChangepoint(plain, day.tempC)), 0);
  const seasonalLoss = days.reduce(
    (sum, day) => sum + Math.abs(day.kwh - predictChangepoint(final, day.tempC) - seasonKwh * day.season),
    0,
  );
  if (!Number.isFinite(seasonalLoss) || seasonalLoss > (1 - SEASON_MIN_LOSS_REDUCTION) * plainLoss) return null;
  // The season and the heating term overlap (cold days come in winter); when the
  // history cannot tell them apart, the size can run off while the heating refit
  // compensates. Usage above the balance point must stay positive at both solstices.
  if (final.line.intercept - Math.abs(seasonKwh) <= 0) return null;
  return { fit: final, seasonKwh };
}

const predictChangepoint = (fit: ChangepointFit, tempC: number): number => (
  fit.line.intercept + fit.line.slope * Math.max(0, fit.balancePointC - tempC)
);

function fitBestChangepoint(days: FitDay[]): ChangepointFit | null {
  let best: { line: RobustLine; balancePointC: number; loss: number } | null = null;
  let worstLoss = 0;
  for (const tau of BALANCE_POINT_GRID_C) {
    const points = days.map((day) => ({ x: Math.max(0, tau - day.tempC), y: day.kwh }));
    const line = theilSen(points);
    if (!line) continue;
    const loss = points.reduce((sum, point) => sum + Math.abs(point.y - (line.intercept + line.slope * point.x)), 0);
    worstLoss = Math.max(worstLoss, loss);
    if (!best || loss < best.loss) best = { line, balancePointC: tau, loss };
  }
  if (!best) return null;
  const chosen = best;
  // τ is only identifiable when the data spans the knee: every τ at or above
  // the observed max yields an identical loss (a winter window's tied
  // plateau), and the strict < tie-break would fabricate the lowest tied τ.
  if (days.filter((day) => day.tempC > chosen.balancePointC).length < MIN_DAYS_ABOVE_BALANCE) return null;
  // An exact fit is a perfect changepoint, not a degenerate one.
  if (chosen.loss === 0) return { line: chosen.line, balancePointC: chosen.balancePointC };
  // Near-identical loss across the whole grid means every candidate degrades
  // to the same shifted line — τ is not identifiable.
  if ((worstLoss - chosen.loss) / chosen.loss < CHANGEPOINT_DEGENERACY_SPREAD) return null;
  return { line: chosen.line, balancePointC: chosen.balancePointC };
}

/**
 * Theil–Sen line. The pairwise slopes go into a typed array and are sorted
 * natively: the fit runs this for every balance-point candidate on every
 * season pass, and a comparator sort over ~66k slopes per call dominated the
 * fit's time on the hub.
 */
function theilSen(points: Array<{ x: number; y: number }>): RobustLine | null {
  const buffer = new Float64Array((points.length * (points.length - 1)) / 2);
  let count = 0;
  for (let i = 0; i < points.length; i += 1) {
    const from = points[i];
    if (from === undefined) continue;
    for (let j = i + 1; j < points.length; j += 1) {
      const to = points[j];
      if (to === undefined) continue;
      const dx = to.x - from.x;
      if (dx === 0) continue;
      buffer[count] = (to.y - from.y) / dx;
      count += 1;
    }
  }
  if (count === 0) return null;
  const sortedSlopes = buffer.subarray(0, count).sort();
  const slope = sortedMedian(sortedSlopes);
  const intercept = median(points.map((point) => point.y - slope * point.x));
  return { slope, intercept, sortedSlopes };
}

/** Median of an ascending typed array; same interpolation as `quantile(values, 0.5)`. */
function sortedMedian(sorted: Float64Array): number {
  const lower = sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
  const upper = sorted[Math.ceil((sorted.length - 1) / 2)] ?? 0;
  return (lower + upper) / 2;
}

function senSlopeInterval(sorted: Float64Array, n: number): { low: number; high: number } | null {
  if (sorted.length < 3) return null;
  const halfWidth = SEN_CI_Z * Math.sqrt((n * (n - 1) * (2 * n + 5)) / 18);
  const lowIndex = Math.max(0, Math.floor((sorted.length - halfWidth) / 2));
  const highIndex = Math.min(sorted.length - 1, Math.ceil((sorted.length + halfWidth) / 2));
  const low = sorted[lowIndex];
  const high = sorted[highIndex];
  // Both indices are clamped into a sample of at least three; an out-of-range
  // slot would mean no interval, which is this function's own absent result.
  if (low === undefined || high === undefined) return null;
  return { low, high };
}

function pseudoR2L1(values: number[], residuals: number[]): number {
  const center = median(values);
  const baseline = values.reduce((sum, value) => sum + Math.abs(value - center), 0);
  if (baseline === 0) return 0;
  const residual = residuals.reduce((sum, value) => sum + Math.abs(value), 0);
  return Math.max(0, 1 - residual / baseline);
}

/** Recent days running above what's typical for their temperature ⇒ regime may have changed. */
function detectDrift(residuals: number[]): boolean {
  if (residuals.length < DRIFT_RECENT_DAYS * 2) return false;
  const recent = residuals.slice(-DRIFT_RECENT_DAYS);
  // Baseline excludes the recent window: at small n the drifted days would
  // otherwise dominate their own comparison quantile and mask the shift.
  const baseline = residuals.slice(0, -DRIFT_RECENT_DAYS);
  return median(recent) > quantile(baseline, 0.75);
}

/**
 * Compares the heating slope on the cold vs warm half of the HEATING regime
 * only. For changepoint homes, days above the balance point must be excluded
 * first — the flat segment would dilute the warm half's slope and make the
 * hinge itself read as "curvature" on perfectly straight resistive homes.
 */
function detectColdCurvature(days: FitDay[], balancePointC: number | undefined): boolean {
  const heatingDays = balancePointC === undefined
    ? days
    : days.filter((day) => day.tempC < balancePointC);
  const sorted = [...heatingDays].sort((a, b) => a.tempC - b.tempC);
  const half = Math.floor(sorted.length / 2);
  const cold = sorted.slice(0, half);
  const warm = sorted.slice(half);
  if (cold.length < CURVATURE_MIN_DAYS_PER_HALF || warm.length < CURVATURE_MIN_DAYS_PER_HALF) return false;
  const coldLine = theilSen(cold.map((day) => ({ x: -day.tempC, y: day.kwh })));
  const warmLine = theilSen(warm.map((day) => ({ x: -day.tempC, y: day.kwh })));
  if (!coldLine || !warmLine) return false;
  if (coldLine.slope <= 0 || warmLine.slope <= 0) return false;
  return coldLine.slope > CURVATURE_STEEPER_FACTOR * warmLine.slope;
}

function resolveConfidence(params: {
  model: EnergySignatureModel;
  usableDays: number;
  temps: number[];
  pseudoR2: number;
  slope: number;
  ci: { low: number; high: number } | null;
  driftSuspected: boolean;
}): EnergySignatureConfidence {
  const { model, usableDays, temps, pseudoR2, slope, ci, driftSuspected } = params;
  if (model === 'uncorrelated') return 'learning';
  const range = Math.max(...temps) - Math.min(...temps);
  const iqr = quantile(temps, 0.75) - quantile(temps, 0.25);
  const ciWidthFraction = ci && slope > 0 ? (ci.high - ci.low) / slope : Number.POSITIVE_INFINITY;
  const spreadOk = range >= 8 && iqr >= 4;
  const tiers: Array<{ tier: EnergySignatureConfidence; days: number; r2: number; ciMax: number }> = [
    { tier: 'high', days: 90, r2: 0.7, ciMax: 0.15 },
    { tier: 'medium', days: 45, r2: 0.6, ciMax: 0.25 },
    { tier: 'low', days: MIN_USABLE_DAYS, r2: 0.4, ciMax: 0.35 },
  ];
  let resolved: EnergySignatureConfidence = 'learning';
  for (const { tier, days, r2, ciMax } of tiers) {
    if (spreadOk && usableDays >= days && pseudoR2 >= r2 && ciWidthFraction <= ciMax) {
      resolved = tier;
      break;
    }
  }
  if (driftSuspected) return dropOneTier(resolved);
  return resolved;
}

function dropOneTier(tier: EnergySignatureConfidence): EnergySignatureConfidence {
  if (tier === 'high') return 'medium';
  if (tier === 'medium') return 'low';
  return 'learning';
}

function predictWithLine(
  model: EnergySignatureModel,
  line: RobustLine,
  balancePointC: number | undefined,
  tempC: number,
): number {
  if (model === 'changepoint') {
    return line.intercept + line.slope * Math.max(0, (balancePointC ?? 0) - tempC);
  }
  if (model === 'linear') {
    return line.intercept + line.slope * -tempC;
  }
  return line.intercept;
}

function median(values: number[]): number {
  return quantile(values, 0.5);
}

/** Linear-interpolated quantile over an unsorted sample; 0 on empty input. */
export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  // `position` is clamped to the sample by construction; the empty-input
  // result (0, per the doc comment above) is the only honest fallback.
  if (lowerValue === undefined || upperValue === undefined) return 0;
  if (lower === upper) return lowerValue;
  const weight = position - lower;
  return lowerValue * (1 - weight) + upperValue * weight;
}


/** Budget and browser verdicts share the same recent-usage calibration. */
export function resolveResidualHeadroom(fit: EnergySignatureFit): { q80: number; q90: number } {
  return {
    q80: Math.max(fit.residualQ80, fit.recentResidualQ80 ?? fit.residualQ80),
    q90: Math.max(fit.residualQ90, fit.recentResidualQ90 ?? fit.residualQ90),
  };
}
