// PV forecast service — learns this home's PV gain from its own recorded output
// and forecasts forward generation. The runtime brain that ties the pure solar
// math together:
//
//   record:   generation power → per-hour energy (pvGenerationHistory) + the
//             concurrent MET cloud stamped per hour
//   learn:    complete recorded hours → (clear-sky, cloud, generation) training
//             points → fitPvGain
//   forecast: forward hours → clear-sky × MET-cloud-forecast × learned gain
//
// SDK-free: coordinates and cloud cover are injected (the setup layer wires the
// Homey geolocation manager and the MET cloud provider; tests mock them).

import {
  emptyPvGenerationHistory,
  pruneOldHours,
  pvTrainingHours,
  recordPvSample,
  type PvGenerationHistory,
} from '../../packages/shared-domain/src/solar/pvGenerationHistory';
import { clearSkyGhiWm2 } from '../../packages/shared-domain/src/solar/clearSky';
import { fitPvGain, type PvGainFit, type PvGainTrainingPoint } from '../../packages/shared-domain/src/solar/pvGain';
import { forecastPvKwh } from '../../packages/shared-domain/src/solar/pvForecast';

const HOUR_MS = 3_600_000;
const HALF_HOUR_MS = 1_800_000;
const DEFAULT_RETENTION_MS = 90 * 24 * HOUR_MS;

export type GeoCoordinates = { latitude: number; longitude: number };

/**
 * Per-hour cloud cover (0 clear .. 1 overcast) for a UTC hour-start. Serves both
 * the recorded nowcast (cloud at the time generation occurred, for training) and
 * the forward forecast. `undefined` when MET has no reading for that hour.
 */
export type PvCloudProvider = {
  getCloudFraction: (hourStartMs: number) => number | undefined;
};

export type PvForecastServiceState = {
  history: PvGenerationHistory;
  /** MET cloud cover (0..1) recorded for each UTC hour-start, for training. */
  cloudByHour: Record<string, number>;
};

export type PvForecastHour = { hourStartMs: number; generationKwh: number };

export type PvForecastServiceDeps = {
  getCoordinates: () => GeoCoordinates | null;
  clouds: PvCloudProvider;
  retentionMs?: number;
  initialState?: PvForecastServiceState;
};

const hourStartMs = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS;

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

export class PvForecastService {
  private history: PvGenerationHistory;
  private cloudByHour: Record<string, number>;
  // Memoised gain: the fit walks the whole recorded window (trig per hour), so it
  // is computed at most once per data change rather than on every forecast call.
  // `undefined` = stale (recompute on next read); `null` = fit but still learning.
  // Keyed by the coordinates it was computed from — a geolocation change re-derives
  // every clear-sky training point, so it must invalidate the cache too.
  private cachedFit: PvGainFit | null | undefined;
  private cachedFitCoordinates: GeoCoordinates | undefined;
  private readonly getCoordinates: () => GeoCoordinates | null;
  private readonly clouds: PvCloudProvider;
  private readonly retentionMs: number;

  constructor(deps: PvForecastServiceDeps) {
    this.getCoordinates = deps.getCoordinates;
    this.clouds = deps.clouds;
    this.retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
    this.history = deps.initialState?.history ?? emptyPvGenerationHistory();
    this.cloudByHour = { ...(deps.initialState?.cloudByHour ?? {}) };
  }

  /** Fold one generation power sample (W) and stamp the hour's concurrent cloud. */
  recordSample(generationW: number, atMs: number): void {
    this.history = recordPvSample(this.history, generationW, atMs);
    const cloud = this.clouds.getCloudFraction(hourStartMs(atMs));
    if (typeof cloud === 'number' && Number.isFinite(cloud)) {
      this.cloudByHour[String(hourStartMs(atMs))] = clampUnit(cloud);
    }
    this.cachedFit = undefined; // new data ⇒ re-fit on next read
  }

  /** Drop recorded generation + cloud older than the retention window. */
  prune(nowMs: number): void {
    this.history = pruneOldHours(this.history, nowMs, this.retentionMs);
    const cutoff = nowMs - this.retentionMs;
    const cloudByHour: Record<string, number> = {};
    for (const [key, value] of Object.entries(this.cloudByHour)) {
      if (Number(key) >= cutoff) cloudByHour[key] = value;
    }
    this.cloudByHour = cloudByHour;
    this.cachedFit = undefined;
  }

  /** The persistable state (history + recorded cloud). */
  getState(): PvForecastServiceState {
    return { history: this.history, cloudByHour: { ...this.cloudByHour } };
  }

  /**
   * Fit the device gain from complete recorded hours that also carry a cloud
   * reading, or `null` while still learning (too few usable hours / no location).
   */
  getFit(): PvGainFit | null {
    const coordinates = this.getCoordinates();
    // Never cache a no-location result: geolocation can appear AFTER the first
    // forecast attempt (e.g. with persisted history already present), and a cached
    // null would suppress the forecast until an unrelated sample invalidated it.
    if (!coordinates) return null;
    const sameLocation = this.cachedFitCoordinates !== undefined
      && this.cachedFitCoordinates.latitude === coordinates.latitude
      && this.cachedFitCoordinates.longitude === coordinates.longitude;
    if (this.cachedFit !== undefined && sameLocation) return this.cachedFit;
    this.cachedFit = this.computeFit(coordinates);
    // Snapshot the numeric values — a provider returning a mutated-in-place object
    // would otherwise alias the live object and defeat the equality check above.
    this.cachedFitCoordinates = { latitude: coordinates.latitude, longitude: coordinates.longitude };
    return this.cachedFit;
  }

  private computeFit(coordinates: GeoCoordinates): PvGainFit | null {
    const points: PvGainTrainingPoint[] = [];
    for (const hour of pvTrainingHours(this.history)) {
      const cloudFraction = this.cloudByHour[String(hour.hourStartMs)];
      if (typeof cloudFraction !== 'number') continue;
      points.push({
        clearSkyWm2: clearSkyGhiWm2(coordinates.latitude, coordinates.longitude, hour.hourStartMs + HALF_HOUR_MS),
        cloudFraction,
        generationKwh: hour.generationKwh,
      });
    }
    return fitPvGain(points);
  }

  /**
   * Forecast generation (kWh) for the given forward UTC hour-starts. Empty when
   * not yet armed (no fit / no location); hours without a cloud forecast are
   * skipped rather than guessed.
   */
  forecast(hourStarts: readonly number[]): PvForecastHour[] {
    const fit = this.getFit();
    const coordinates = this.getCoordinates();
    if (!fit || !coordinates) return [];
    const result: PvForecastHour[] = [];
    for (const hourStart of hourStarts) {
      const cloudFraction = this.clouds.getCloudFraction(hourStart);
      if (typeof cloudFraction !== 'number') continue;
      const clearSkyWm2 = clearSkyGhiWm2(coordinates.latitude, coordinates.longitude, hourStart + HALF_HOUR_MS);
      result.push({
        hourStartMs: hourStart,
        generationKwh: forecastPvKwh(fit.gainKwhPerWm2, clearSkyWm2, cloudFraction),
      });
    }
    return result;
  }
}
