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

export type PvHourBucket = {
  /** Measured generation energy (kWh) integrated into this hour. */
  kwh: number;
  /** Total sampled duration (ms) attributed to this hour, for completeness. */
  coveredMs: number;
};

export type PvGenerationHistory = {
  /** Timestamp of the last integrated sample, if any. */
  lastSampleMs?: number;
  /** Generation power (W, >= 0) carried from the last sample over the next interval. */
  lastGenerationW?: number;
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

/**
 * Add energy + coverage for the interval [t0, t1) at constant `powerW`, splitting
 * it at hour boundaries so a straddling interval is attributed proportionally to
 * each hour it actually spans.
 */
const accumulateInterval = (
  hourly: Record<string, PvHourBucket>,
  powerW: number,
  t0: number,
  t1: number,
): Record<string, PvHourBucket> => {
  const next = { ...hourly };
  let cursor = t0;
  while (cursor < t1) {
    const hourEnd = hourStartMs(cursor) + HOUR_MS;
    const segmentEnd = Math.min(t1, hourEnd);
    const segmentMs = segmentEnd - cursor;
    const key = String(hourStartMs(cursor));
    const prev = next[key] ?? { kwh: 0, coveredMs: 0 };
    next[key] = {
      kwh: prev.kwh + (powerW / 1000) * (segmentMs / HOUR_MS),
      coveredMs: prev.coveredMs + segmentMs,
    };
    cursor = segmentEnd;
  }
  return next;
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
  maxGapMs: number = PV_SAMPLE_MAX_GAP_MS,
): PvGenerationHistory => {
  const genW = finiteNonNegative(generationW);
  const { lastSampleMs, lastGenerationW, hourly } = history;

  // Out-of-order or unusable timestamp: ignore it so the cursor stays monotonic.
  if (!Number.isFinite(atMs) || (lastSampleMs !== undefined && atMs <= lastSampleMs)) {
    return history;
  }
  // First sample: just anchor (no prior interval to credit or taint).
  if (lastSampleMs === undefined || lastGenerationW === undefined) {
    return { ...history, lastSampleMs: atMs, lastGenerationW: genW };
  }
  // Gap too large to trust: re-anchor forward and taint the hours the hole touched
  // — the hour it began in, and (when it ended mid-hour) the hour it ended in — so
  // neither is mistaken for complete however the deficit splits across the boundary.
  if (atMs - lastSampleMs > maxGapMs) {
    const taintedHourStarts = { ...(history.taintedHourStarts ?? {}) };
    taintedHourStarts[String(hourStartMs(lastSampleMs))] = true;
    if (atMs % HOUR_MS !== 0) taintedHourStarts[String(hourStartMs(atMs))] = true;
    return { ...history, lastSampleMs: atMs, lastGenerationW: genW, taintedHourStarts };
  }
  return {
    ...history,
    lastSampleMs: atMs,
    lastGenerationW: genW,
    hourly: accumulateInterval(hourly, lastGenerationW, lastSampleMs, atMs),
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

export type PvHourSample = { hourStartMs: number; generationKwh: number };

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
    .map(([key, bucket]) => ({ hourStartMs: Number(key), generationKwh: bucket.kwh }))
    .sort((a, b) => a.hourStartMs - b.hourStartMs);
};
