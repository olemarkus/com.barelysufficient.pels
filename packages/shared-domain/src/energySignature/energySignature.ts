import type {
  EnergySignatureConfidence,
  EnergySignatureFit,
  EnergySignatureModel,
  WeatherDailyRecord,
} from '../../../contracts/src/weatherAdvisorTypes';

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

type FitDay = { tempC: number; kwh: number };

type RobustLine = { slope: number; intercept: number; slopes: number[] };

export function fitEnergySignature(records: WeatherDailyRecord[], nowMs: number): EnergySignatureFit | null {
  const usable = selectUsableDays(records);
  if (usable.length < MIN_USABLE_DAYS) return null;

  const temps = usable.map((day) => day.tempC);
  const kwhs = usable.map((day) => day.kwh);
  const observedTempMinC = Math.min(...temps);
  const observedTempMaxC = Math.max(...temps);
  const medianDayKwh = median(kwhs);
  const lowObservedDayKwh = quantile(kwhs, 0.05);

  const { model, line, balancePointC } = resolveModel(usable);
  const residuals = usable.map((day) => day.kwh - predictWithLine(model, line, balancePointC, day.tempC));
  const pseudoR2 = pseudoR2L1(kwhs, residuals);
  const ci = senSlopeInterval(line.slopes, usable.length);
  const driftSuspected = detectDrift(residuals);
  const confidence = resolveConfidence({
    model, usableDays: usable.length, temps, pseudoR2, slope: line.slope, ci, driftSuspected,
  });

  return {
    model,
    ...(model === 'changepoint' ? { baseLoadKwhPerDay: line.intercept, balancePointC } : {}),
    ...(model === 'linear' ? { interceptKwhAtZeroC: line.intercept } : {}),
    slopeKwhPerDegree: line.slope,
    ...(ci ? { slopeCiLow: ci.low, slopeCiHigh: ci.high } : {}),
    pseudoR2,
    usableDays: usable.length,
    observedTempMinC,
    observedTempMaxC,
    medianDayKwh,
    lowObservedDayKwh,
    confidence,
    curvatureSteeperWhenCold: model !== 'uncorrelated' && detectColdCurvature(usable, balancePointC),
    ...(model !== 'uncorrelated' ? { heatLossWPerK: (line.slope * 1000) / 24 } : {}),
    driftSuspected,
    residualQ10: quantile(residuals, 0.1),
    residualQ50: quantile(residuals, 0.5),
    residualQ80: quantile(residuals, 0.8),
    residualQ90: quantile(residuals, 0.9),
    fittedAtMs: nowMs,
  };
}

/** Expected kWh for a day with the given mean temperature; undefined when usage is uncorrelated. */
export function predictDailyKwh(fit: EnergySignatureFit, tempMeanC: number): number | undefined {
  if (fit.model === 'uncorrelated') return undefined;
  if (fit.model === 'changepoint') {
    const base = fit.baseLoadKwhPerDay ?? 0;
    const balance = fit.balancePointC ?? 0;
    return base + fit.slopeKwhPerDegree * Math.max(0, balance - tempMeanC);
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

function selectUsableDays(records: WeatherDailyRecord[]): FitDay[] {
  return records
    .filter((record) => isUsableSignatureDay(record))
    // Deliberately the trailing USABLE days, not calendar days: windowing
    // before the quality filter would shrink the sample after flaky stretches
    // and can drop the fit below the 21-day gate entirely. The drift detector
    // slices the same usable axis, so recency stays mutually consistent.
    .slice(-FIT_WINDOW_DAYS)
    .map((record) => ({ tempC: record.tempMeanC, kwh: record.kwhTotal as number }));
}

function resolveModel(days: FitDay[]): {
  model: EnergySignatureModel;
  line: RobustLine;
  balancePointC?: number;
} {
  const changepoint = fitBestChangepoint(days);
  if (changepoint && changepoint.line.slope > 0) {
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
  return { model: 'uncorrelated', line: { slope: 0, intercept: median(days.map((d) => d.kwh)), slopes: [] } };
}

function fitBestChangepoint(days: FitDay[]): { line: RobustLine; balancePointC: number } | null {
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

function theilSen(points: Array<{ x: number; y: number }>): RobustLine | null {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dx = points[j].x - points[i].x;
      if (dx === 0) continue;
      slopes.push((points[j].y - points[i].y) / dx);
    }
  }
  if (slopes.length === 0) return null;
  const slope = median(slopes);
  const intercept = median(points.map((point) => point.y - slope * point.x));
  return { slope, intercept, slopes };
}

function senSlopeInterval(slopes: number[], n: number): { low: number; high: number } | null {
  if (slopes.length < 3) return null;
  const sorted = [...slopes].sort((a, b) => a - b);
  const halfWidth = SEN_CI_Z * Math.sqrt((n * (n - 1) * (2 * n + 5)) / 18);
  const lowIndex = Math.max(0, Math.floor((sorted.length - halfWidth) / 2));
  const highIndex = Math.min(sorted.length - 1, Math.ceil((sorted.length + halfWidth) / 2));
  return { low: sorted[lowIndex], high: sorted[highIndex] };
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
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
