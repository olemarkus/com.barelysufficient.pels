/**
 * The PV-forecast controller: records generation, learns this home's gain from
 * its own output, forecasts forward, and persists the result behind a boot-read
 * write gate.
 *
 * It lives here, not in `setup/`, because it is a component and not wiring: it
 * holds the write gate, a dormancy latch, and a refresh/persist/prune schedule
 * that all outlive any single call (`setup/AGENTS.md` § "No state").
 * Everything Homey-shaped is injected — the userdata store, the coordinate
 * read, the clock — so this file needs no SDK and `setup/` keeps only the
 * construction that binds them.
 */

import { OpenMeteoIrradianceProvider } from './openMeteoIrradiance';
import { emptyPvForecastServiceState, PvForecastService } from './pvForecastService';
import type { HubCoordinatesResult, PvForecastStore } from './pvForecastStore';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import { normalizeError } from '../utils/errorUtils';

export const PV_FORECAST_USER_AGENT = 'com.barelysufficient.pels (PELS PV forecast)';

const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000; // forecast is hourly; refresh every 3 h
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Minimal structured-log surface (satisfied by the pino logger). */
export type PvForecastLogger = {
  info: (obj: Record<string, unknown>) => void;
  warn: (obj: Record<string, unknown>) => void;
};

export type PvForecastControllerCtx = {
  /** Userdata-backed persistence (`createPvForecastStateStore`). */
  store: PvForecastStore;
  /** Identifies this app to Open-Meteo (attribution / contact). */
  userAgent: string;
  getNowMs: () => number;
  readCoordinates: () => Promise<HubCoordinatesResult>;
  logger: PvForecastLogger;
};



export class PvForecastController {
  readonly service: PvForecastService;
  private readonly provider: OpenMeteoIrradianceProvider;
  private readonly store: PvForecastStore;
  private readonly getNowMs: () => number;
  private readonly readCoordinates: () => Promise<HubCoordinatesResult>;
  private readonly logger: PvForecastLogger;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private dirty = false;
  // Whether the store has answered a read. Until it has, persists are deferred
  // and each persist tick re-reads it, so a store that recovers is merged under
  // the live state, never overwritten by it. No clock opens the gate: the
  // history is up to 90 days of the home's own generation.
  private storeAnswered: boolean;
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
    this.readCoordinates = ctx.readCoordinates;
    this.logger = ctx.logger;
    this.store = ctx.store;
    this.provider = new OpenMeteoIrradianceProvider({
      userAgent: ctx.userAgent,
    });
    // `loaded` seeds the service and `absent` starts it empty, both final; a
    // read that threw defers writes until the store answers.
    const boot = this.store.read();
    this.service = new PvForecastService({
      irradiance: this.provider,
      initialState: boot.kind === 'loaded' ? boot.state : emptyPvForecastServiceState(),
    });
    this.active = Object.keys(this.service.getState().history.hourly).length > 0;
    this.storeAnswered = boot.kind !== 'unreadable';
    // One structured line per boot: what the store answered.
    this.logger.info({ event: 'pv_forecast_boot_read', result: boot.kind });
  }

  /** Re-read the store while it has not answered. A `loaded` answer merges the
   *  stored state under the live one and opens the write gate, as does an
   *  `absent` one; a read that throws again leaves the gate shut. Never
   *  throws — the store answers a thrown read as `unreadable`, so this stays
   *  safe inside the `setInterval` / `stop()` paths. */
  private tryRecoverPersistedState(): void {
    const reread = this.store.read();
    if (reread.kind === 'unreadable') return;
    this.storeAnswered = true;
    if (reread.kind === 'absent') return;
    this.service.mergeRecoveredState(reread.state);
    const wasActive = this.active;
    this.active = wasActive || Object.keys(this.service.getState().history.hourly).length > 0;
    this.logger.info({
      event: 'pv_forecast_state_recovered',
      recoveredHours: Object.keys(reread.state.history.hourly).length,
    });
    // A dormant boot skipped start()'s initial refresh. Recovered history
    // arming the forecaster must fetch irradiance NOW — waiting for the
    // fixed 3-hour refresh tick would leave forecasts dark for hours.
    // `refresh()` no-ops after stop(), so a shutdown-path recovery is safe.
    if (!wasActive && this.active) void this.refresh();
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

  /** Whether the home has shown solar production (recorded history or a live
   *  positive sample) — the same signal that arms this controller's own
   *  Open-Meteo fetches. The Homey solar-forecast controller reads it as its
   *  auto-probe arm signal so a non-solar home probes neither source. */
  isActive(): boolean {
    return this.active;
  }

  /** Refetch the irradiance forecast and emit the learned gain. No-op while dormant
   *  (a non-solar home never reaches the network); failures are logged, not thrown. */
  async refresh(): Promise<void> {
    if (!this.active || this.stopped) return;
    const outcome = await this.refreshProvider().catch((error: unknown) => {
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

  private async refreshProvider(): Promise<'ok' | 'no_location' | 'failed'> {
    const location = await this.readCoordinates();
    if (this.stopped) return 'failed';
    if (location.kind === 'unavailable') return location.outcome;
    return this.provider.refresh(location.coordinates);
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
    const gain = this.service.getFit();
    if (gain.kind === 'learning') return;
    this.logger.info({
      event: 'pv_forecast_learned',
      gainKwhPerWm2: gain.fit.gainKwhPerWm2,
      confidence: gain.fit.confidence,
      sampleCount: gain.fit.sampleCount,
      // Observability for tuning the clamp-evidence thresholds — never branched on.
      trainingMode: gain.fit.trainingMode,
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
    // Until the store answers, re-read it on EVERY tick — before the dirty
    // gate, so a home with no generation overnight still re-reads all night
    // instead of meeting the store exactly once at sunrise.
    if (!this.storeAnswered) this.tryRecoverPersistedState();
    if (!this.dirty) return;
    if (!this.storeAnswered) {
      // Diagnostic trace that a write was intentionally deferred to protect
      // stored history the store could not read: if the app is killed now,
      // the log shows samples were dropped by design, not lost to a bug.
      this.logger.info({ event: 'pv_forecast_persist_skipped_grace' });
      return; // retried on the next persist tick
    }
    try {
      this.store.write(this.service.getState());
      this.dirty = false;
    } catch (error) {
      this.logger.warn({ event: 'pv_forecast_persist_failed', err: normalizeError(error) });
    }
  }
}
