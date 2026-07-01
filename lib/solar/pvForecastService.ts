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
// Open-Meteo-backed provider; tests mock it). The provider encapsulates location,
// so the service needs no coordinates of its own — the fit is `generation /
// irradiance`, which is location-agnostic.

import {
  emptyPvGenerationHistory,
  pruneOldHours,
  pvTrainingHours,
  recordPvSample,
  type PvGenerationHistory,
} from '../../packages/shared-domain/src/solar/pvGenerationHistory';
import { fitPvGain, type PvGainFit, type PvGainTrainingPoint } from '../../packages/shared-domain/src/solar/pvGain';
import { forecastPvKwh } from '../../packages/shared-domain/src/solar/pvForecast';
import { isFiniteNumber } from '../utils/appTypeGuards';

const HOUR_MS = 3_600_000;
const DEFAULT_RETENTION_MS = 90 * 24 * HOUR_MS;

/**
 * Per-hour shortwave irradiance (W/m²) for a UTC hour-start. Serves both the
 * recorded nowcast (irradiance at the time generation occurred, for training) and
 * the forward forecast. `undefined` when the source has no value for that hour.
 */
export type PvIrradianceProvider = {
  getIrradiance: (hourStartMs: number) => number | undefined;
};

export type PvForecastServiceState = {
  history: PvGenerationHistory;
  /** Shortwave irradiance (W/m²) recorded for each UTC hour-start, for training. */
  irradianceByHour: Record<string, number>;
};

export type PvForecastHour = { hourStartMs: number; generationKwh: number };

export type PvForecastServiceDeps = {
  irradiance: PvIrradianceProvider;
  retentionMs?: number;
  initialState?: PvForecastServiceState;
};

const hourStartMs = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;

export class PvForecastService {
  private history: PvGenerationHistory;
  private irradianceByHour: Record<string, number>;
  // Memoised gain: the fit walks the whole recorded window, so it is computed at
  // most once per data change rather than on every forecast call. `undefined` =
  // stale (recompute on next read); `null` = fit but still learning. Only data
  // (history + recorded irradiance) feeds the fit, so a sample/prune invalidation
  // is sufficient — there is no location to key on.
  private cachedFit: PvGainFit | null | undefined;
  private readonly irradiance: PvIrradianceProvider;
  private readonly retentionMs: number;

  constructor(deps: PvForecastServiceDeps) {
    this.irradiance = deps.irradiance;
    this.retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
    this.history = deps.initialState?.history ?? emptyPvGenerationHistory();
    this.irradianceByHour = { ...(deps.initialState?.irradianceByHour ?? {}) };
  }

  /** Fold one generation power sample (W) and stamp the hour's concurrent
   *  irradiance. `netW` is the co-sampled SIGNED net home power (W, import
   *  positive) used as zero-export-clamp evidence; omitted when unknown. */
  recordSample(generationW: number, atMs: number, netW?: number): void {
    this.history = recordPvSample(this.history, generationW, atMs, { netW });
    const irradianceWm2 = this.irradiance.getIrradiance(hourStartMs(atMs));
    if (isFiniteNumber(irradianceWm2) && irradianceWm2 >= 0) {
      this.irradianceByHour[String(hourStartMs(atMs))] = irradianceWm2;
    }
    this.cachedFit = undefined; // new data ⇒ re-fit on next read
  }

  /** Drop recorded generation + irradiance older than the retention window. */
  prune(nowMs: number): void {
    this.history = pruneOldHours(this.history, nowMs, this.retentionMs);
    const cutoff = nowMs - this.retentionMs;
    const irradianceByHour: Record<string, number> = {};
    for (const [key, value] of Object.entries(this.irradianceByHour)) {
      if (Number(key) >= cutoff) irradianceByHour[key] = value;
    }
    this.irradianceByHour = irradianceByHour;
    this.cachedFit = undefined;
  }

  /** The persistable state (history + recorded irradiance). */
  getState(): PvForecastServiceState {
    return { history: this.history, irradianceByHour: { ...this.irradianceByHour } };
  }

  /**
   * Fit the device gain from complete recorded hours that also carry an irradiance
   * reading, or `null` while still learning (too few usable hours).
   */
  getFit(): PvGainFit | null {
    if (this.cachedFit !== undefined) return this.cachedFit;
    this.cachedFit = this.computeFit();
    return this.cachedFit;
  }

  private computeFit(): PvGainFit | null {
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
   * Forecast generation (kWh) for the given forward UTC hour-starts. Empty when not
   * yet armed (no fit); hours without a forecast irradiance are skipped rather than
   * guessed.
   */
  forecast(hourStarts: readonly number[]): PvForecastHour[] {
    const fit = this.getFit();
    if (!fit) return [];
    const result: PvForecastHour[] = [];
    for (const hourStart of hourStarts) {
      const irradianceWm2 = this.irradiance.getIrradiance(hourStart);
      if (!isFiniteNumber(irradianceWm2)) continue;
      result.push({ hourStartMs: hourStart, generationKwh: forecastPvKwh(fit.gainKwhPerWm2, irradianceWm2) });
    }
    return result;
  }
}
