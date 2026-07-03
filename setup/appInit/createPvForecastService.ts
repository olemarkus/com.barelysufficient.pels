// Wiring for the learned PV-generation forecast: constructs the Open-Meteo
// irradiance provider + the PvForecastService over the persisted state, feeds it
// generation samples from the power pipeline, and schedules the periodic forecast
// refresh, state persistence, and history prune. Owns the timers + SDK seams so
// the service/provider stay SDK-free and unit-testable. Every background timer /
// async op is guarded so a transient SDK/network failure can never crash the loop.

import { OpenMeteoIrradianceProvider } from '../../lib/solar/openMeteoIrradiance';
import { PvForecastService } from '../../lib/solar/pvForecastService';
import { createPvForecastStore, type PvForecastStore } from '../pvForecastStateAdapter';
import { readHubCoordinates } from './createWeatherCollector';
import { isFiniteNumber } from '../../lib/utils/appTypeGuards';
import { normalizeError } from '../../lib/utils/errorUtils';
import { getLogger } from '../../lib/logging/logger';
import type { AppContext } from '../../lib/app/appContext';

const PV_FORECAST_USER_AGENT = 'com.barelysufficient.pels (PELS PV forecast)';

const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000; // forecast is hourly; refresh every 3 h
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Abandon-grace after an absent/implausible boot read: while it is open, every
// persist RE-READS the store first, so a transient SDK miss that has since healed
// is adopted rather than overwritten. Kept comfortably above PERSIST_INTERVAL_MS
// so several persist ticks fall inside the window before emptiness is accepted as
// a genuine fresh install. Mirrors WeatherCollector's LOAD_GRACE_MS.
const LOAD_GRACE_MS = 15 * 60 * 1000;

export type PvForecastControllerHomey = {
  settings: { get: (key: string) => unknown; set: (key: string, value: unknown) => void };
  geolocation?: unknown;
};

/** Minimal structured-log surface (satisfied by the pino logger). */
export type PvForecastLogger = {
  info: (obj: Record<string, unknown>) => void;
  warn: (obj: Record<string, unknown>) => void;
};

export type PvForecastControllerCtx = {
  homey: PvForecastControllerHomey;
  /** Identifies this app to Open-Meteo (attribution / contact). */
  userAgent: string;
  getNowMs: () => number;
  logger: PvForecastLogger;
};

export class PvForecastController {
  readonly service: PvForecastService;
  private readonly provider: OpenMeteoIrradianceProvider;
  private readonly store: PvForecastStore;
  private readonly getNowMs: () => number;
  private readonly logger: PvForecastLogger;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private dirty = false;
  // Set at boot when the persisted read came back absent/implausible (a transient
  // SDK miss OR a genuine fresh install — indistinguishable at that instant).
  // While set and within LOAD_GRACE_MS, persists re-read before overwriting so a
  // transient miss cannot clobber learned history. Cleared once a real state is
  // recovered or the first post-grace write lands.
  private loadedEmptyAtMs?: number;
  // Completion hook: fires after each SUCCESSFUL provider refresh (fresh
  // irradiance landed). Wiring registers it AFTER the budget-price inputs are
  // wired (`wireBudgetPrice`), so it can never trigger a combined-prices
  // recompute before the planning-price inputs exist. Unset ⇒ no-op.
  private onRefreshed?: () => void;
  // Latched by stop(): an Open-Meteo fetch still in flight at app uninit must
  // not drive the hook (or any other completion work) after teardown.
  private stopped = false;
  // Dormant until the home shows POSITIVE solar generation: non-solar homes report
  // no `generationW` (and a generation device can report 0 at night before any
  // production), so neither must reach Open-Meteo. Armed by recorded history at boot
  // or the first positive live sample.
  private active: boolean;

  constructor(ctx: PvForecastControllerCtx) {
    this.getNowMs = ctx.getNowMs;
    this.logger = ctx.logger;
    this.store = createPvForecastStore(ctx.homey);
    this.provider = new OpenMeteoIrradianceProvider({
      getCoordinates: () => readHubCoordinates(ctx.homey.geolocation),
      userAgent: ctx.userAgent,
    });
    // Capture the boot read once: an absent/implausible read (a transient SDK
    // miss OR a genuine fresh install) both yield `undefined`. Arming the load
    // grace makes the early persists re-read before overwriting — a transient
    // miss then heals into a recovery instead of clobbering months of learned
    // history; a real fresh install just waits out the grace, then persists.
    const initialState = this.store.read();
    this.service = new PvForecastService({ irradiance: this.provider, initialState });
    this.active = Object.keys(this.service.getState().history.hourly).length > 0;
    if (initialState === undefined) this.loadedEmptyAtMs = this.getNowMs();
  }

  private isLoadGraceActive(): boolean {
    return this.loadedEmptyAtMs !== undefined
      && this.getNowMs() - this.loadedEmptyAtMs < LOAD_GRACE_MS;
  }

  /** Re-read the store after an absent/implausible boot read; adopt real history
   *  and clear the grace on success. Returns false while the store is still
   *  unreadable or genuinely empty (a fresh install). The re-read hits the Homey
   *  SDK, and this runs inside a `setInterval` / `stop()` path, so a transient
   *  `settings.get` throw must be swallowed here — otherwise it escapes the timer
   *  and crashes the process during exactly the boot-read failure this guards. */
  private tryRecoverPersistedState(): boolean {
    try {
      const recovered = this.store.read();
      if (recovered === undefined || Object.keys(recovered.history.hourly).length === 0) return false;
      this.service.adoptRecoveredState(recovered);
      this.active = true;
      this.loadedEmptyAtMs = undefined;
      this.logger.info({ event: 'pv_forecast_state_recovered' });
      return true;
    } catch (error) {
      // Treat a thrown re-read like a still-unreadable store: keep the grace armed
      // so a later tick retries, and never overwrite possibly-good on-disk history.
      this.logger.warn({ event: 'pv_forecast_recovery_failed', err: normalizeError(error) });
      return false;
    }
  }

  /** Fold a generation power sample from the power pipeline (no-op if unknown).
   *  `netPowerW` is the co-sampled SIGNED net home power (import positive) used as
   *  zero-export-clamp evidence for gain training — finiteness-gated here at the
   *  boundary so junk never reaches the pure history math. */
  recordSample(generationW: number | undefined, nowMs: number, netPowerW?: number): void {
    // Boundary gate: a non-finite timestamp would mint junk hour keys downstream
    // (persisted `irradianceByHour['NaN']`, unusable history cursor) — drop the sample.
    if (!isFiniteNumber(generationW) || !isFiniteNumber(nowMs)) return;
    if (!this.active) {
      if (generationW <= 0) return; // still dormant — wait for real production
      this.active = true; // first positive generation ⇒ start forecasting
      void this.refresh();
    }
    this.service.recordSample(generationW, nowMs, isFiniteNumber(netPowerW) ? netPowerW : undefined);
    this.dirty = true;
  }

  /** Register the refresh-completion hook (invoked only after a successful provider refresh). */
  setOnRefreshed(callback: () => void): void {
    this.onRefreshed = callback;
  }

  /** Refetch the irradiance forecast and emit the learned gain. No-op while dormant
   *  (a non-solar home never reaches the network); failures are logged, not thrown. */
  async refresh(): Promise<void> {
    if (!this.active || this.stopped) return;
    const outcome = await this.provider.refresh().catch((error: unknown) => {
      this.logger.warn({ event: 'pv_forecast_refresh_failed', err: normalizeError(error) });
      return 'failed' as const;
    });
    // Torn down while the fetch was in flight — drop the completion entirely.
    if (this.stopped) return;
    this.emitLearnedForecast();
    // Only a real forecast update completes the hook — a failed/location-less
    // refresh changed nothing, so nothing downstream needs recomputing.
    if (outcome === 'ok') this.onRefreshed?.();
  }

  start(): void {
    void this.refresh();
    this.timers.push(setInterval(() => { void this.refresh(); }, REFRESH_INTERVAL_MS));
    this.timers.push(setInterval(() => this.persistIfDirty(), PERSIST_INTERVAL_MS));
    this.timers.push(setInterval(() => this.pruneSafely(), PRUNE_INTERVAL_MS));
  }

  stop(): void {
    this.stopped = true;
    // Drop the hook so a late completion can never reach the price layer.
    this.onRefreshed = undefined;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.persistIfDirty();
  }

  /** Structured signal of what the app learned — the externally-observable forecast seam. */
  private emitLearnedForecast(): void {
    const fit = this.service.getFit();
    if (!fit) return;
    this.logger.info({
      event: 'pv_forecast_learned',
      gainKwhPerWm2: fit.gainKwhPerWm2,
      confidence: fit.confidence,
      sampleCount: fit.sampleCount,
      // Observability for tuning the clamp-evidence thresholds — never branched on.
      trainingMode: fit.trainingMode,
    });
  }

  private pruneSafely(): void {
    try {
      this.service.prune(this.getNowMs());
      this.dirty = true;
    } catch (error) {
      this.logger.warn({ event: 'pv_forecast_prune_failed', err: normalizeError(error) });
    }
  }

  private persistIfDirty(): void {
    if (!this.dirty) return;
    // Booted from an absent/implausible read: re-read the store before writing so
    // a transient SDK miss that has since healed is ADOPTED, never overwritten.
    // Emptiness is accepted (a genuine fresh install) only once every re-read
    // across the grace window still comes back unreadable.
    if (this.loadedEmptyAtMs !== undefined && !this.tryRecoverPersistedState() && this.isLoadGraceActive()) {
      // Diagnostic trace that a write was intentionally deferred to protect
      // possibly-good on-disk history (mirrors WeatherCollector's skip log): if
      // the app is killed inside the window, the log shows samples were dropped
      // by design, not lost to a bug.
      this.logger.info({ event: 'pv_forecast_persist_skipped_grace' });
      return; // retried on the next persist tick
    }
    try {
      this.store.write(this.service.getState());
      this.dirty = false;
      // The store now reflects memory; a later re-read could only regress to it.
      this.loadedEmptyAtMs = undefined;
    } catch (error) {
      this.logger.warn({ event: 'pv_forecast_persist_failed', err: normalizeError(error) });
    }
  }
}

/**
 * Construct AND start the PV-forecast controller from the app context: it records
 * gross generation fed from the power pipeline plus Open-Meteo irradiance, learns
 * the device gain, and forecasts forward solar output. Pure data — it never touches
 * shed/capacity decisions; no-op until positive generation is seen.
 */
export function createPvForecastController(ctx: AppContext): PvForecastController {
  const controller = new PvForecastController({
    homey: ctx.homey,
    userAgent: PV_FORECAST_USER_AGENT,
    getNowMs: () => Date.now(),
    logger: getLogger('solar'),
  });
  controller.start();
  return controller;
}
