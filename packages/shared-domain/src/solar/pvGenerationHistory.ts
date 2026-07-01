// PV generation history — the recorded training data for the learned PV gain.
//
// PELS exposes solar generation only as instantaneous POWER (`generationW`, from
// Homey Energy's `totalGenerated.W`); there is no cumulative generation-energy
// meter. This pure module integrates that power stream into per-hour generation
// ENERGY (kWh) AND per-hour sampled coverage, keyed by UTC hour-start, and retains
// a rolling window — the (clear-sky vs measured) pairs the PV-gain fit trains on.
//
// Coverage is the load-bearing idea: only fully-sampled hours are valid training
// data. An hour that is still accumulating (the live cursor), or that a restart /
// meter outage left a hole in, has < 1 h of covered time and is excluded — pairing
// a partial hour with a full-hour clear-sky value would bias the learned gain.
//
// Keyed in UTC by instant (not local clock) so each recorded hour pairs directly
// with the clear-sky model evaluated at the same instant; mapping to the user's
// local hours is a downstream (forecast/blend) concern. Browser-safe: arithmetic
// only, no SDK, no timezone dependency.

const HOUR_MS = 3_600_000;

/** Samples farther apart than this are treated as a gap (restart / meter outage)
 *  and re-anchor rather than integrate a stale power across the hole. */
export const PV_SAMPLE_MAX_GAP_MS = 5 * 60 * 1000;

/** An hour must be sampled at least this fraction of its duration to count as a
 *  complete (trainable) generation hour.
 *
 *  Deliberately set above `1 − PV_SAMPLE_MAX_GAP_MS / 1 h` (≈0.917): sample gaps
 *  short enough to integrate (<= max gap) leave NO coverage hole, so any hour that
 *  suffered a re-anchored hole is missing >= one max-gap (>= ~8.3%) and necessarily
 *  falls under this bar. A clean, continuously-sampled hour sits at ~1.0. One
 *  threshold thus separates complete hours from gap-tainted ones — no per-hour
 *  taint tracking needed. */
export const PV_HOUR_MIN_COVERAGE = 0.95;

// --- Net-power evidence (zero-export clamp detection) ------------------------
//
// In a zero-export home the inverter clamps production to house consumption, so
// bright training hours read systematically LOW and a median-trained gain
// underestimates true PV potential (self-reinforcing: low forecast → no surplus →
// no load shift → the clamp stays binding). To let the gain fit segment its
// training hours, each recorded hour also accrues how much of its sampled time
// the home spent importing / exporting, from the SIGNED net home power
// co-sampled with generation. The thresholds below are physics-informed guesses —
// dogfood-tunable via the `pv_forecast_learned` structured log (which carries the
// resulting `trainingMode`).

/** Sustained net import above this (W) is consumption the inverter could have
 *  offset but didn't — evidence it was already at max (clamp NOT binding). Sits
 *  above the ~100–200 W standing import a zero-export controller regulates
 *  around. Physics-informed guess; dogfood-tunable. */
export const PV_IMPORT_EVIDENCE_MIN_W = 500;

/** Net export deeper than this (W) counts as real export — a zero-export limiter
 *  cannot have been active. Physics-informed guess; dogfood-tunable. */
export const PV_EXPORT_EVIDENCE_MIN_W = 100;

/** Fraction of an hour's net-covered time that must be importing for the import
 *  route to declare the hour unclamped. Physics-informed guess; dogfood-tunable. */
export const PV_UNCLAMPED_IMPORT_MIN_FRACTION = 0.95;

/** Cumulative dual-endpoint export time (ms) in an hour that rules out a binding
 *  zero-export clamp. 10 min: single-sample overshoot blips are already killed by
 *  the dual-endpoint rule, so this much genuine export means the limiter was not
 *  meaningfully binding. Physics-informed guess; dogfood-tunable. */
export const PV_UNCLAMPED_EXPORT_MIN_MS = 600_000;

/** An hour classifies at all only when nearly all its sampled time carries net
 *  evidence — below this it stays 'unknown' (pre-upgrade history, partial net
 *  data), so legacy exporting homes never fall into the quantile mode. */
export const PV_NET_CLASSIFIED_MIN_FRACTION = 0.95;

export type PvHourBucket = {
  /** Measured generation energy (kWh) integrated into this hour. */
  kwh: number;
  /** Total sampled duration (ms) attributed to this hour, for completeness. */
  coveredMs: number;
  /** Sampled time (ms) with a known signed net power. ABSENT == recorded before
   *  net evidence existed (legacy/unknown); present-with-zeros == measured — the
   *  distinction is load-bearing for classification. */
  netMs?: number;
  /** Net-covered time (ms) spent importing above `PV_IMPORT_EVIDENCE_MIN_W`. */
  importMs?: number;
  /** Net-covered time (ms) spent exporting beyond `PV_EXPORT_EVIDENCE_MIN_W` at
   *  BOTH interval endpoints (dual-endpoint — blip-resistant). */
  exportMs?: number;
};

export type PvGenerationHistory = {
  /** Timestamp of the last integrated sample, if any. */
  lastSampleMs?: number;
  /** Generation power (W, >= 0) carried from the last sample over the next interval. */
  lastGenerationW?: number;
  /** SIGNED net home power (W, import positive / export negative) carried from the
   *  last sample. DROPPED (not carried) by a sample that arrives without a net
   *  reading, so `netMs` never accrues over time the net was not actually observed. */
  lastNetW?: number;
  /** Per-hour energy + coverage by UTC hour-start ms (stringified key). */
  hourly: Record<string, PvHourBucket>;
  /** UTC hour-starts a re-anchored sample gap left a hole in — excluded from
   *  training however the hole's deficit splits across the hour boundary. */
  taintedHourStarts?: Record<string, true>;
};

export const emptyPvGenerationHistory = (): PvGenerationHistory => ({ hourly: {} });

const hourStartMs = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;

const finiteNonNegative = (value: number): number => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

/** Signed net power at the interval's endpoints, when observed. */
type IntervalNet = {
  /** Net power (W) carried over the interval (the previous sample's reading). */
  carriedNetW?: number;
  /** Net power (W) at the interval's end (the incoming sample's reading). */
  incomingNetW?: number;
};

const isFinite_ = (value: number | undefined): value is number => (
  value !== undefined && Number.isFinite(value)
);

/**
 * Resolve the interval's net evidence once (segments of a split interval share
 * it). Import/net accrual uses the carried value alone (mirrors the kWh carry
 * semantics); export accrual requires BOTH endpoints beyond the export bar so a
 * single-sample overshoot blip between two non-export readings accrues nothing.
 */
const resolveIntervalNetEvidence = (
  net: IntervalNet,
): { hasNet: boolean; importing: boolean; exporting: boolean } => {
  if (!isFinite_(net.carriedNetW)) return { hasNet: false, importing: false, exporting: false };
  return {
    hasNet: true,
    importing: net.carriedNetW > PV_IMPORT_EVIDENCE_MIN_W,
    exporting: net.carriedNetW < -PV_EXPORT_EVIDENCE_MIN_W
      && isFinite_(net.incomingNetW) && net.incomingNetW < -PV_EXPORT_EVIDENCE_MIN_W,
  };
};

/**
 * Add energy + coverage (and, when the interval carries a net reading, net-power
 * evidence) for the interval [t0, t1) at constant `powerW`, splitting it at hour
 * boundaries so a straddling interval is attributed proportionally to each hour
 * it actually spans.
 */
const accumulateInterval = (
  hourly: Record<string, PvHourBucket>,
  powerW: number,
  t0: number,
  t1: number,
  net: IntervalNet,
): Record<string, PvHourBucket> => {
  const evidence = resolveIntervalNetEvidence(net);
  const next = { ...hourly };
  let cursor = t0;
  while (cursor < t1) {
    const hourEnd = hourStartMs(cursor) + HOUR_MS;
    const segmentEnd = Math.min(t1, hourEnd);
    const segmentMs = segmentEnd - cursor;
    const key = String(hourStartMs(cursor));
    const prev = next[key] ?? { kwh: 0, coveredMs: 0 };
    next[key] = {
      ...prev,
      kwh: prev.kwh + (powerW / 1000) * (segmentMs / HOUR_MS),
      coveredMs: prev.coveredMs + segmentMs,
      // Without a net reading the evidence fields stay exactly as they were (via
      // the spread above) — absence, not zero, is what marks an unmeasured hour.
      ...(evidence.hasNet
        ? {
          netMs: (prev.netMs ?? 0) + segmentMs,
          importMs: (prev.importMs ?? 0) + (evidence.importing ? segmentMs : 0),
          exportMs: (prev.exportMs ?? 0) + (evidence.exporting ? segmentMs : 0),
        }
        : {}),
    };
    cursor = segmentEnd;
  }
  return next;
};

export type RecordPvSampleOptions = {
  /** Overrides `PV_SAMPLE_MAX_GAP_MS` (tests only). */
  maxGapMs?: number;
  /** SIGNED net home power (W, import positive) co-sampled with the generation
   *  reading; omitted when unknown. Producer-validated (finite) upstream. */
  netW?: number;
};

/**
 * Fold one generation sample into the history. Energy for the interval since the
 * previous sample (`lastGenerationW × Δt`) is integrated and split across the
 * hours it spans. The first sample, an out-of-order sample, or one beyond
 * `maxGapMs` integrates nothing — out-of-order samples are ignored outright so the
 * cursor stays monotonic; a too-large gap re-anchors forward without crediting the
 * hole (leaving the straddled hour under-covered, hence excluded from training).
 */
export const recordPvSample = (
  history: PvGenerationHistory,
  generationW: number,
  atMs: number,
  options: RecordPvSampleOptions = {},
): PvGenerationHistory => {
  const maxGapMs = options.maxGapMs ?? PV_SAMPLE_MAX_GAP_MS;
  const genW = finiteNonNegative(generationW);
  const { lastSampleMs, lastGenerationW, lastNetW, hourly } = history;

  // Out-of-order or unusable timestamp: ignore it so the cursor stays monotonic.
  if (!Number.isFinite(atMs) || (lastSampleMs !== undefined && atMs <= lastSampleMs)) {
    return history;
  }
  // The advanced cursor every accepted sample shares. Deliberately NOT
  // `...history`: a sample WITHOUT a net reading must DROP the carried `lastNetW`
  // (spreading the old history back in would keep it alive and let `netMs` accrue
  // over time the net was never observed).
  const advanced: PvGenerationHistory = {
    hourly,
    ...(history.taintedHourStarts === undefined ? {} : { taintedHourStarts: history.taintedHourStarts }),
    lastSampleMs: atMs,
    lastGenerationW: genW,
    ...(isFinite_(options.netW) ? { lastNetW: options.netW } : {}),
  };
  // First sample: just anchor (no prior interval to credit or taint).
  if (lastSampleMs === undefined || lastGenerationW === undefined) {
    return advanced;
  }
  // Gap too large to trust: re-anchor forward and taint the hours the hole touched
  // — the hour it began in, and (when it ended mid-hour) the hour it ended in — so
  // neither is mistaken for complete however the deficit splits across the boundary.
  if (atMs - lastSampleMs > maxGapMs) {
    const taintedHourStarts = { ...(history.taintedHourStarts ?? {}) };
    taintedHourStarts[String(hourStartMs(lastSampleMs))] = true;
    if (atMs % HOUR_MS !== 0) taintedHourStarts[String(hourStartMs(atMs))] = true;
    return { ...advanced, taintedHourStarts };
  }
  return {
    ...advanced,
    hourly: accumulateInterval(hourly, lastGenerationW, lastSampleMs, atMs, {
      carriedNetW: lastNetW,
      incomingNetW: options.netW,
    }),
  };
};

/** Drop hours older than `retentionMs` before `nowMs`. Keeps the live cursor. */
export const pruneOldHours = (
  history: PvGenerationHistory,
  nowMs: number,
  retentionMs: number,
): PvGenerationHistory => {
  const cutoff = nowMs - retentionMs;
  const hourly: Record<string, PvHourBucket> = {};
  for (const [key, bucket] of Object.entries(history.hourly)) {
    if (Number(key) >= cutoff) hourly[key] = bucket;
  }
  const taintedHourStarts: Record<string, true> = {};
  for (const key of Object.keys(history.taintedHourStarts ?? {})) {
    if (Number(key) >= cutoff) taintedHourStarts[key] = true;
  }
  return { ...history, hourly, taintedHourStarts };
};

/**
 * Was the inverter provably NOT clamped this hour ('unclamped'), possibly clamped
 * ('suspect'), or is there no usable net data ('unknown')? Resolved here in the
 * producer stack — downstream consumers receive the flat value and must not
 * re-derive or second-guess it.
 */
export type PvNetEvidence = 'unclamped' | 'suspect' | 'unknown';

export const classifyHourNetEvidence = (bucket: PvHourBucket): PvNetEvidence => {
  const netMs = bucket.netMs ?? 0;
  // Nearly the whole sampled hour must carry net evidence to classify at all —
  // absent/partial net data (pre-upgrade history, mid-hour net dropouts) stays
  // 'unknown', a deliberate third class so legacy exporting homes never fall into
  // the clamp-aware quantile mode.
  if (netMs <= 0 || netMs < PV_NET_CLASSIFIED_MIN_FRACTION * bucket.coveredMs) return 'unknown';
  // IMPORT route: sustained real import above the zero-export standing-import
  // deadband ⇒ the inverter was at max (a binding clamp would have offset it).
  if ((bucket.importMs ?? 0) >= PV_UNCLAMPED_IMPORT_MIN_FRACTION * netMs) return 'unclamped';
  // EXPORT route: sustained dual-endpoint export ⇒ no zero-export limiter active.
  // (Documented non-goal: partial-export-limit homes — e.g. the German 70% rule —
  // misclassify via this route; not a Norwegian residential pattern.)
  if ((bucket.exportMs ?? 0) >= PV_UNCLAMPED_EXPORT_MIN_MS) return 'unclamped';
  // Zero-export clamp / battery absorb / balanced load — deliberately conflated:
  // a battery-absorb exclusion only thins the unclamped pool, never biases it.
  return 'suspect';
};

export type PvHourSample = {
  hourStartMs: number;
  generationKwh: number;
  netEvidence: PvNetEvidence;
};

/**
 * Recorded hours with positive generation AND near-full sampling coverage,
 * ascending by instant — the training set the PV-gain fit consumes (each paired
 * with clear-sky downstream). The coverage gate excludes the still-open hour and
 * any outage/restart-tainted partial hour in one rule.
 */
export const pvTrainingHours = (
  history: PvGenerationHistory,
  minCoverage: number = PV_HOUR_MIN_COVERAGE,
): PvHourSample[] => {
  const minCoveredMs = minCoverage * HOUR_MS;
  // The live hour is excluded explicitly (not just via coverage): in its last 10%
  // it can already exceed the coverage gate yet still be missing its final minutes.
  const openHourStartMs = history.lastSampleMs === undefined
    ? undefined
    : hourStartMs(history.lastSampleMs);
  const tainted = history.taintedHourStarts ?? {};
  return Object.entries(history.hourly)
    .filter(([key, bucket]) => {
      const start = Number(key);
      return Number.isFinite(start)
        && start !== openHourStartMs
        && !tainted[key]
        && bucket.kwh > 0
        && bucket.coveredMs >= minCoveredMs;
    })
    .map(([key, bucket]) => ({
      hourStartMs: Number(key),
      generationKwh: bucket.kwh,
      netEvidence: classifyHourNetEvidence(bucket),
    }))
    .sort((a, b) => a.hourStartMs - b.hourStartMs);
};
