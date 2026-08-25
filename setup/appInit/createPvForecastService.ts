// Wiring for the learned PV-generation forecast: constructs the Open-Meteo
// irradiance provider + the PvForecastService over the persisted state, feeds it
// generation samples from the power pipeline, and schedules the periodic forecast
// refresh, state persistence, and history prune. Owns the timers + SDK seams so
// the service/provider stay SDK-free and unit-testable. Every background timer /
// async op is guarded so a transient SDK/network failure can never crash the loop.

import { OpenMeteoIrradianceProvider } from '../../lib/solar/openMeteoIrradiance';
import { emptyPvForecastServiceState, PvForecastService } from '../../lib/solar/pvForecastService';
import {
  createPvForecastStore,
  type PvForecastStateRead,
  type PvForecastStore,
  type PvForecastStoreSettings,
} from '../pvForecastStateAdapter';
import { readHubCoordinates, type HubCoordinatesResult } from '../homeyLocationAdapter';
import { isFiniteNumber } from '../../lib/utils/appTypeGuards';
import { normalizeError } from '../../lib/utils/errorUtils';
import { getLogger } from '../../lib/logging/logger';
import type { AppContext } from '../../lib/app/appContext';

const PV_FORECAST_USER_AGENT = 'com.barelysufficient.pels (PELS PV forecast)';

const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000; // forecast is hourly; refresh every 3 h
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Per-arm write-gate doctrine (the #2197/#2198 precedent). An `unreadable`
// store — thrown, malformed, or self-contradicting probes — defers writes for
// the PROCESS LIFETIME: no clock may expire ambiguity into a write, because a
// time-bounded abandonment overwrites up to 90 days at the exact moment the
// SDK heals. Only a CLEANLY OBSERVED shape may open the gate, and each does so
// by being re-observed across spaced re-reads for a window measured from ITS
// OWN transition (never inherited from boot or a previous shape — a single
// clean read right after an unreadable stretch proves nothing).
//
// `absent` (fresh install: no blob, no marker, healthy key list without the
// key) confirms after one further spaced re-read — there is provably nothing
// recorded, and a brand-new install's first persist should not wait long.
const ABSENT_CONFIRM_GRACE_MS = PERSIST_INTERVAL_MS;
// `marker_only` (half-persist: the marker-first write landed, the blob write
// never did) confirms across ~3 spaced re-reads. It is the arm that un-wedges
// a store whose marker survived a crash — without it, process-lifetime
// deferral would leave PV persistence permanently unwritable — but it is also
// the shape a correlated get/getKeys lie would fake, so it earns the longer
// window before a write may land on it.
const MARKER_ONLY_CONFIRM_GRACE_MS = 15 * 60 * 1000;

export type PvForecastControllerHomey = { settings: PvForecastStoreSettings };

// Whether the boot read may be trusted as the last word on persisted history.
// While anything but `trusted`, destructive persists are deferred and every
// persist tick re-reads the store, so a healed read is merged, never
// overwritten. `suspect_unreadable` carries no clock — ambiguity never expires
// into a write. `confirming` tracks one cleanly observed shape being
// re-observed across spaced re-reads; its window starts at the transition into
// that shape (see the per-arm doctrine at the grace constants).
type PvBootReadTrust =
  | { kind: 'trusted' }
  | { kind: 'suspect_unreadable' }
  | { kind: 'confirming'; observed: 'absent' | 'marker_only'; sinceMs: number; graceMs: number };

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
  private bootReadTrust: PvBootReadTrust;
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
    this.store = createPvForecastStore(ctx.homey);
    this.provider = new OpenMeteoIrradianceProvider({
      userAgent: ctx.userAgent,
    });
    // Classify the boot read once at the adapter seam: `loaded` seeds the
    // service and is trusted outright; a cleanly observed `absent` or
    // `marker_only` starts its confirmation across spaced re-reads; an
    // `unreadable` read defers writes with no clock at all — so the 5-minute
    // persist timer cannot overwrite up to 90 days of learned generation
    // history on the strength of one failed SDK read.
    const boot = this.store.read();
    this.service = new PvForecastService({
      irradiance: this.provider,
      initialState: boot.kind === 'loaded' ? boot.state : emptyPvForecastServiceState(),
    });
    this.active = Object.keys(this.service.getState().history.hourly).length > 0;
    this.bootReadTrust = this.initialTrustFor(boot);
    // One structured line per boot: how the persisted state was classified —
    // the only trace of a thrown/malformed/unproven read at the moment it
    // happened (the adapter classifies instead of throwing).
    this.logger.info({
      event: 'pv_forecast_boot_read',
      result: boot.kind,
      ...(boot.kind === 'unreadable' ? { reason: boot.reason } : {}),
    });
  }

  private initialTrustFor(boot: PvForecastStateRead): PvBootReadTrust {
    if (boot.kind === 'loaded') return { kind: 'trusted' };
    if (boot.kind === 'unreadable') return { kind: 'suspect_unreadable' };
    return this.startConfirming(boot.kind);
  }

  /** Enter the confirmation state for a cleanly observed shape. The window is
   *  measured from THIS transition — never inherited from boot or a previous
   *  shape — so clean absence must persist across spaced re-reads. */
  private startConfirming(observed: 'absent' | 'marker_only'): PvBootReadTrust {
    return {
      kind: 'confirming',
      observed,
      sinceMs: this.getNowMs(),
      graceMs: observed === 'absent' ? ABSENT_CONFIRM_GRACE_MS : MARKER_ONLY_CONFIRM_GRACE_MS,
    };
  }

  /** Re-read the store while the boot read is untrusted and advance the trust
   *  state machine. A `loaded` answer merges the recovered state into the live
   *  one (a no-op overlay when the recovered side is empty — a store that
   *  answered with a real blob has proved itself readable) and clears the
   *  suspicion. An `unreadable` answer discards any confirmation progress —
   *  ambiguity never expires into a write. A clean `absent` / `marker_only`
   *  either continues its own confirmation (trusted once re-observed past the
   *  window) or starts one at this transition. Never throws — the adapter
   *  classifies a thrown SDK read as `unreadable`, so this stays safe inside
   *  the `setInterval` / `stop()` paths. */
  private tryRecoverPersistedState(): void {
    const reread = this.store.read();
    if (reread.kind === 'loaded') {
      this.service.mergeRecoveredState(reread.state);
      const wasActive = this.active;
      this.active = wasActive || Object.keys(this.service.getState().history.hourly).length > 0;
      this.bootReadTrust = { kind: 'trusted' };
      this.logger.info({
        event: 'pv_forecast_state_recovered',
        recoveredHours: Object.keys(reread.state.history.hourly).length,
      });
      // A dormant boot skipped start()'s initial refresh. Recovered history
      // arming the forecaster must fetch irradiance NOW — waiting for the
      // fixed 3-hour refresh tick would leave forecasts dark for hours.
      // `refresh()` no-ops after stop(), so a shutdown-path recovery is safe.
      if (!wasActive && this.active) void this.refresh();
      return;
    }
    if (reread.kind === 'unreadable') {
      this.bootReadTrust = { kind: 'suspect_unreadable' };
      return;
    }
    // A cleanly observed shape (`absent` | `marker_only`).
    const trust = this.bootReadTrust;
    if (trust.kind === 'confirming' && trust.observed === reread.kind) {
      if (this.getNowMs() - trust.sinceMs >= trust.graceMs) {
        // Re-observed past its own window: the shape is confirmed and the
        // write gate opens on a recoverable fresh start.
        this.bootReadTrust = { kind: 'trusted' };
        this.logger.info({ event: 'pv_forecast_absence_confirmed', observed: reread.kind });
      }
      return;
    }
    this.bootReadTrust = this.startConfirming(reread.kind);
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
    // While the boot read is untrusted, try to resolve it on EVERY tick —
    // before the dirty gate, so a home with no generation overnight still
    // re-reads all night instead of meeting the store exactly once at sunrise.
    if (this.bootReadTrust.kind !== 'trusted') this.tryRecoverPersistedState();
    if (!this.dirty) return;
    if (this.bootReadTrust.kind !== 'trusted') {
      // Still unresolved: the write gate opens only through a `loaded` merge
      // or a clean shape re-observed past its own confirmation window — never
      // by time elapsing over an unreadable store.
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
      this.bootReadTrust = { kind: 'trusted' };
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
    readCoordinates: readHubCoordinates,
    logger: getLogger('solar'),
  });
  controller.start();
  return controller;
}
