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
//
// Zero-export twist: a clamped inverter makes bright hours read systematically LOW
// with LOW scatter, so a plain median underestimates true potential while looking
// confident. When per-hour net-power evidence exists (see pvGenerationHistory),
// the fit trains on provably-unclamped hours alone; when the evidence is
// clamp-DOMINATED it falls back to an upper quantile of the evidence-bearing pool
// (bounded by the best hour actually observed — a less-wrong, safe-direction
// estimate); without evidence it is byte-identical to the legacy median.

export type PvGainTrainingPoint = {
  /** Shortwave irradiance the panels received for the hour (W/m²). */
  irradianceWm2: number;
  /** Measured generation energy for the hour (kWh). */
  generationKwh: number;
  /** Producer-resolved net-power evidence for the hour; 'unknown' hours OMIT the
   *  field (see `classifyHourNetEvidence` in pvGenerationHistory). */
  netEvidence?: 'unclamped' | 'suspect';
};

export type PvGainConfidence = 'low' | 'medium' | 'high';

/** How the gain was trained — LOG OBSERVABILITY ONLY: consumers MUST NOT branch
 *  on it (resolution belongs in the producer; the fit's meaning is complete in
 *  `gainKwhPerWm2` + `confidence`). */
export type PvGainTrainingMode = 'unclamped_median' | 'clamp_aware_quantile' | 'unsegmented_median';

export type PvGainFit = {
  /** Learned device gain in kWh per (W/m²·hour). */
  gainKwhPerWm2: number;
  /** Hours that fed the trained pool (see `trainingMode` for which pool). */
  sampleCount: number;
  /** Median absolute deviation of the pool's gains around the fit / gain. */
  relativeScatter: number;
  confidence: PvGainConfidence;
  /** Log observability only — consumers MUST NOT branch on it. */
  trainingMode: PvGainTrainingMode;
};

/**
 * What this home's gain currently IS. `learning` is a named member, not a null:
 * a new install genuinely has no gain yet, and that state can last for days —
 * too few hours clear the irradiance floor, or the hours that did showed no
 * positive generation to divide. It is a state of the home's learning, so
 * consumers discriminate it (and say "none") instead of null-checking a
 * business value or, worse, defaulting one.
 */
export type LearnedPvGain =
  | { kind: 'fitted'; fit: PvGainFit }
  | { kind: 'learning' };

// Below this irradiance the hour is too dim to learn from (dawn/dusk/deep
// overcast): a tiny denominator amplifies measurement noise into the gain.
const MIN_IRRADIANCE_WM2 = 50;

/** Minimum trained hours before a gain is returned at all (≈ a few daylight days). */
export const MIN_PV_GAIN_SAMPLES = 24;

/** Quantile of the evidence-bearing gain pool used when the evidence is
 *  clamp-dominated: high enough to reach past the clamped mass toward the best
 *  observed hours, low enough to stay robust to a stray over-read. Physics-informed
 *  guess; dogfood-tunable via the `pv_forecast_learned` log's `trainingMode`. */
export const PV_GAIN_CLAMP_QUANTILE = 0.9;

/** Suspect hours must OUTNUMBER unclamped hours by this ratio before the quantile
 *  mode engages. A genuinely clamped home has unclamped ≈ 0, so dominance holds
 *  trivially; an exporting or battery home warming up its evidence accrues BOTH
 *  kinds (balanced-load hours classify suspect) and must fall through to the
 *  legacy median rather than inflate its gain to a P90 no clamp justifies.
 *  Physics-informed guess; dogfood-tunable. */
export const PV_GAIN_CLAMP_DOMINANCE_RATIO = 2;

const median = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return Number.NaN;
  if (sorted.length % 2 !== 0) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? Number.NaN : (lower + upper) / 2;
};

/** Nearest-rank quantile (no interpolation): the value at rank `ceil(q·n)`. */
const nearestRankQuantile = (values: readonly number[], q: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
};

const resolveConfidence = (sampleCount: number, relativeScatter: number): PvGainConfidence => {
  if (sampleCount >= 168 && relativeScatter <= 0.15) return 'high';
  if (sampleCount >= 72 && relativeScatter <= 0.25) return 'medium';
  return 'low';
};

const finalizeFit = (
  gain: number,
  pool: readonly number[],
  trainingMode: PvGainTrainingMode,
): LearnedPvGain => {
  // A non-finite or non-positive gain means the trained pool showed no
  // generation to learn from — still learning, never a fit of zero.
  if (!Number.isFinite(gain) || gain <= 0) return { kind: 'learning' };
  const mad = median(pool.map((g) => Math.abs(g - gain)));
  const relativeScatter = mad / gain;
  return {
    kind: 'fitted',
    fit: {
      gainKwhPerWm2: gain,
      sampleCount: pool.length,
      relativeScatter,
      // A quantile over a clamp-suspect pool is a bounded guess, not a tight fit:
      // confidence is FORCED low regardless of count/scatter — a tight cluster of
      // clamped hours is exactly the wrong thing to read as high confidence.
      confidence: trainingMode === 'clamp_aware_quantile'
        ? 'low'
        : resolveConfidence(pool.length, relativeScatter),
      trainingMode,
    },
  };
};

/**
 * Fit the device's PV gain from recorded hours, or the `learning` member while
 * too few hours (`MIN_PV_GAIN_SAMPLES`) clear the irradiance floor. Each usable
 * hour contributes `generation / irradiance`. Preference order: median over
 * provably-unclamped hours; else, when suspect hours DOMINATE the evidence
 * (zero-export homes), an upper quantile over the evidence-bearing pool with
 * forced-low confidence; else the legacy unsegmented median.
 */
export const fitPvGain = (points: readonly PvGainTrainingPoint[]): LearnedPvGain => {
  const gains: number[] = [];
  const unclampedGains: number[] = [];
  const suspectGains: number[] = [];
  const evidenceGains: number[] = [];
  for (const point of points) {
    // `!finite` must short-circuit: a NaN irradiance would make `NaN < floor` false
    // and slip a NaN ratio into the median, poisoning the whole gain.
    if (!Number.isFinite(point.irradianceWm2) || point.irradianceWm2 < MIN_IRRADIANCE_WM2) continue;
    if (!Number.isFinite(point.generationKwh) || point.generationKwh < 0) continue;
    const gain = point.generationKwh / point.irradianceWm2;
    gains.push(gain);
    if (point.netEvidence === 'unclamped') unclampedGains.push(gain);
    if (point.netEvidence === 'suspect') suspectGains.push(gain);
    if (point.netEvidence !== undefined) evidenceGains.push(gain);
  }
  // (1) Enough provably-unclamped hours: train on them alone — clamped hours would
  // only drag the median down.
  if (unclampedGains.length >= MIN_PV_GAIN_SAMPLES) {
    return finalizeFit(median(unclampedGains), unclampedGains, 'unclamped_median');
  }
  // (2) Clamp-DOMINATED evidence (the de-facto primary path for a low-daytime-load
  // zero-export home): an upper quantile of the EVIDENCE-BEARING gains only.
  // Dominance (not mere count) is required so an exporting/battery home warming up
  // its evidence falls through to the median instead of a structural overestimate;
  // legacy 'unknown' hours are excluded so pre-upgrade history cannot set the
  // quantile. Bounded by the best evidence-bearing hour actually observed — it
  // cannot recover potential no hour ever showed, only a less-wrong (safe-
  // direction) underestimate.
  if (suspectGains.length >= MIN_PV_GAIN_SAMPLES
    && suspectGains.length >= PV_GAIN_CLAMP_DOMINANCE_RATIO * unclampedGains.length) {
    return finalizeFit(
      nearestRankQuantile(evidenceGains, PV_GAIN_CLAMP_QUANTILE),
      evidenceGains,
      'clamp_aware_quantile',
    );
  }
  // (3) No (or non-dominant) segmentation evidence: the legacy unsegmented median.
  if (gains.length < MIN_PV_GAIN_SAMPLES) return { kind: 'learning' };
  return finalizeFit(median(gains), gains, 'unsegmented_median');
};
