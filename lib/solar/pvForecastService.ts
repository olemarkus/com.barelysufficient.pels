// PV forecast service — learns this home's PV gain from its own recorded output
// and forecasts forward generation. The runtime brain that ties the pure solar
// math together:
//
//   record:   generation power → per-hour energy (pvGenerationHistory) + the
//             concurrent shortwave irradiance stamped per hour
//   learn:    complete recorded hours → (irradiance, generation) training points
//             → fitPvGain
//   forecast: forward hours → forecast irradiance × learned gain
//
// SDK-free: the irradiance provider is injected (the setup layer wires the
// Open-Meteo-backed provider; tests mock it). The service needs no coordinates
// of its own — the fit is `generation / irradiance`, which is location-agnostic.

import {
  emptyPvGenerationHistory,
  pruneOldHours,
  pvTrainingHours,
  recordPvSample,
  type PvGenerationHistory,
} from '../../packages/shared-domain/src/solar/pvGenerationHistory';
import {
  fitPvGain,
  type LearnedPvGain,
  type PvGainTrainingPoint,
} from '../../packages/shared-domain/src/solar/pvGain';
import { forecastPvKwh } from '../../packages/shared-domain/src/solar/pvForecast';
import { isFiniteNumber } from '../utils/appTypeGuards';

const HOUR_MS = 3_600_000;
const DEFAULT_RETENTION_MS = 90 * 24 * HOUR_MS;
// The forward window `hasForwardForecast` asks about — the same day-ahead span
// the planning price and the curtailment potential read.
const FORWARD_FORECAST_HOURS = 24;

/**
 * One hour's shortwave-irradiance read. `absent` — the source holds no value for
 * that hour — is a named member rather than an absent number: a missing sample
 * is a state of the lookup, and no consumer may read it as 0 W/m² (which would
 * make a bright hour look dark, or a forecast hour look like measured darkness).
 * The `reported` arm carries a FINITE, NON-NEGATIVE W/m²; the provider resolves
 * that at its own boundary and consumers trust it.
 */
export type PvIrradianceRead =
  | { kind: 'reported'; irradianceWm2: number }
  | { kind: 'absent' };

/**
 * Per-hour shortwave irradiance (W/m²) for a UTC hour-start. Serves both the
 * recorded nowcast (irradiance at the time generation occurred, for training) and
 * the forward forecast.
 */
export type PvIrradianceProvider = {
  getIrradiance: (hourStartMs: number) => PvIrradianceRead;
};

export type PvForecastServiceState = {
  history: PvGenerationHistory;
  /** Shortwave irradiance (W/m²) recorded for each UTC hour-start, for training. */
  irradianceByHour: Record<string, number>;
};

/** The zero state a service starts from when persistence had nothing to offer. */
export const emptyPvForecastServiceState = (): PvForecastServiceState => ({
  history: emptyPvGenerationHistory(),
  irradianceByHour: {},
});

export type PvForecastHour = { hourStartMs: number; generationKwh: number };

export type PvForecastServiceDeps = {
  irradiance: PvIrradianceProvider;
  /** Required: the caller resolves what the boot read produced (a loaded state
   *  or `emptyPvForecastServiceState()`) — the service never guesses about
   *  absence (resolution-in-producer). */
  initialState: PvForecastServiceState;
};

const hourStartMs = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;

/** One recovered bucket's taint mark, keyed by the hour of `atMs` — empty when
 *  the recovered side holds no bucket there (nothing at risk to exclude). */
const recoveredBucketTaint = (
  recovered: PvGenerationHistory,
  atMs: number,
): Record<string, true> => {
  const key = String(hourStartMs(atMs));
  return recovered.hourly[key] === undefined ? {} : { [key]: true };
};

/** The restart hole is invisible to `recordPvSample`: the crash dropped its
 *  anchor, so no re-anchor taint was ever recorded for the gap between the
 *  recovered cursor and the first live sample. Mirror recordPvSample's
 *  two-boundary gap semantics on the recovered buckets at BOTH ends:
 *  - the LIVE-cursor hour — future samples integrate forward from the live
 *    cursor into the merged bucket for that hour, so a recovered claim there
 *    would concatenate pre-crash and post-boot accrual as if the outage never
 *    happened;
 *  - the RECOVERED-cursor hour — its bucket stopped accruing at the crash, so
 *    its coverage can clear the training gate while silently missing the tail
 *    of the hour (e.g. 58 min covered, crash at :58, live resumes next hour).
 *  Tainting excludes both from training however their coverage reads. */
const restartHoleTaint = (
  recovered: PvGenerationHistory,
  live: PvGenerationHistory,
): Record<string, true> => {
  if (live.lastSampleMs === undefined) return {}; // no post-boot samples ⇒ no hole yet
  return {
    ...recoveredBucketTaint(recovered, live.lastSampleMs),
    ...(recovered.lastSampleMs === undefined ? {} : recoveredBucketTaint(recovered, recovered.lastSampleMs)),
  };
};

/** Overlay live post-boot accruals onto a history recovered from persistence:
 *  live hours win where they overlap, recovered hours fill the rest. The
 *  cursor triple travels as a unit from the live side whenever it has one (in
 *  a single-process timeline the live cursor is always the later of the two)
 *  and from the recovered side otherwise — splitting the triple would pair a
 *  recovered `lastNetW` with a live cursor and accrue net evidence over time
 *  the net was never observed. Gap-taint marks are unioned (a recovered taint
 *  keeps excluding its hour even when a fresh partial bucket overlays it), and
 *  the live-cursor hour is tainted when both sides claim it — see
 *  `restartHoleTaint`. */
const mergeRecoveredHistory = (
  recovered: PvGenerationHistory,
  live: PvGenerationHistory,
): PvGenerationHistory => {
  const cursor = live.lastSampleMs === undefined ? recovered : live;
  const taintedHourStarts = {
    ...recovered.taintedHourStarts,
    ...live.taintedHourStarts,
    ...restartHoleTaint(recovered, live),
  };
  return {
    hourly: { ...recovered.hourly, ...live.hourly },
    ...(cursor.lastSampleMs === undefined ? {} : { lastSampleMs: cursor.lastSampleMs }),
    ...(cursor.lastGenerationW === undefined ? {} : { lastGenerationW: cursor.lastGenerationW }),
    ...(cursor.lastNetW === undefined ? {} : { lastNetW: cursor.lastNetW }),
    ...(Object.keys(taintedHourStarts).length === 0 ? {} : { taintedHourStarts }),
  };
};

// The gain memo. Nothing memoised yet (or an invalidation since) is a state of
// the MEMO — `stale` — not a missing gain: the gain's own `learning` member
// already means "no fit yet", and one type may not carry both meanings.
type PvGainMemo =
  | { kind: 'stale' }
  | { kind: 'fresh'; gain: LearnedPvGain };

export class PvForecastService {
  private history: PvGenerationHistory;
  private irradianceByHour: Record<string, number>;
  // Memoised gain: the fit walks the whole recorded window, so it is computed at
  // most once per data change rather than on every forecast call. Only data
  // (history + recorded irradiance) feeds the fit, so a sample/prune invalidation
  // is sufficient — there is no location to key on.
  private cachedFit: PvGainMemo = { kind: 'stale' };
  private readonly irradiance: PvIrradianceProvider;

  constructor(deps: PvForecastServiceDeps) {
    this.irradiance = deps.irradiance;
    this.history = deps.initialState.history;
    this.irradianceByHour = { ...deps.initialState.irradianceByHour };
  }

  /** Fold one generation power sample (W) and stamp the hour's concurrent
   *  irradiance. `netW` is the co-sampled SIGNED net home power (W, import
   *  positive) used as zero-export-clamp evidence; omitted when unknown. */
  recordSample(generationW: number, atMs: number, netW?: number): void {
    this.history = recordPvSample(this.history, generationW, atMs, { netW });
    const read = this.irradiance.getIrradiance(hourStartMs(atMs));
    if (read.kind === 'reported') {
      this.irradianceByHour[String(hourStartMs(atMs))] = read.irradianceWm2;
    }
    this.cachedFit = { kind: 'stale' }; // new data ⇒ re-fit on next read
  }

  /** Drop recorded generation + irradiance older than the retention window. */
  prune(nowMs: number): void {
    this.history = pruneOldHours(this.history, nowMs, DEFAULT_RETENTION_MS);
    const cutoff = nowMs - DEFAULT_RETENTION_MS;
    const irradianceByHour: Record<string, number> = {};
    for (const [key, value] of Object.entries(this.irradianceByHour)) {
      if (Number(key) >= cutoff) irradianceByHour[key] = value;
    }
    this.irradianceByHour = irradianceByHour;
    this.cachedFit = { kind: 'stale' };
  }

  /** The persistable state (history + recorded irradiance). */
  getState(): PvForecastServiceState {
    return { history: this.history, irradianceByHour: { ...this.irradianceByHour } };
  }

  /**
   * Fold a state recovered from persistence (after a suspect boot read — see
   * the load-grace path in `PvForecastController`) into the live state.
   * Per-hour accruals recorded since boot WIN where they overlap; the
   * recovered history fills every other hour — so months of recorded
   * generation survive a transient boot-read miss without discarding the
   * samples folded while it healed. Cursor and taint semantics:
   * `mergeRecoveredHistory`.
   */
  mergeRecoveredState(recovered: PvForecastServiceState): void {
    this.history = mergeRecoveredHistory(recovered.history, this.history);
    this.irradianceByHour = { ...recovered.irradianceByHour, ...this.irradianceByHour };
    this.cachedFit = { kind: 'stale' }; // recovered data ⇒ re-fit on next read
  }

  /**
   * Fit the device gain from complete recorded hours that also carry an irradiance
   * reading, or the gain's `learning` member (too few usable hours).
   */
  getFit(): LearnedPvGain {
    if (this.cachedFit.kind === 'fresh') return this.cachedFit.gain;
    const gain = this.computeFit();
    this.cachedFit = { kind: 'fresh', gain };
    return gain;
  }

  private computeFit(): LearnedPvGain {
    const points: PvGainTrainingPoint[] = [];
    for (const hour of pvTrainingHours(this.history)) {
      const irradianceWm2 = this.irradianceByHour[String(hour.hourStartMs)];
      if (!isFiniteNumber(irradianceWm2)) continue;
      points.push({
        irradianceWm2,
        generationKwh: hour.generationKwh,
        // 'unknown' is expressed as an absent field on the training point.
        ...(hour.netEvidence === 'unknown' ? {} : { netEvidence: hour.netEvidence }),
      });
    }
    return fitPvGain(points);
  }

  /**
   * Whether the learned lane can actually ANSWER for the hours ahead — a fit
   * AND forward irradiance to apply it to. A fit alone is not enough: it can be
   * restored from persistence while the in-memory irradiance provider has
   * nothing forward (the location lookup or the startup refresh failed), and
   * then `forecast()` skips every requested hour. Provenance derived from
   * `getFit()` alone would claim a forecast that planning is not getting.
   * Counterpart to `HomeyEnergySolarForecastSource.hasUsefulForecast`.
   */
  hasForwardForecast(nowMs: number): boolean {
    const currentHourStartMs = hourStartMs(nowMs);
    const hourStarts: number[] = [];
    for (let index = 0; index < FORWARD_FORECAST_HOURS; index += 1) {
      hourStarts.push(currentHourStartMs + index * HOUR_MS);
    }
    return this.forecast(hourStarts).length > 0;
  }

  /**
   * Forecast generation (kWh) for the given forward UTC hour-starts. Empty when not
   * yet armed (no fit); hours without a forecast irradiance are skipped rather than
   * guessed.
   */
  forecast(hourStarts: readonly number[]): PvForecastHour[] {
    const learned = this.getFit();
    if (learned.kind === 'learning') return [];
    const result: PvForecastHour[] = [];
    for (const hourStart of hourStarts) {
      const read = this.irradiance.getIrradiance(hourStart);
      if (read.kind === 'absent') continue;
      result.push({
        hourStartMs: hourStart,
        generationKwh: forecastPvKwh(learned.fit.gainKwhPerWm2, read.irradianceWm2),
      });
    }
    return result;
  }
}
