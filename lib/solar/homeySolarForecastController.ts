// Refresh lifecycle for Homey Energy's solar production forecast (firmware
// 13.4.0+): owns the probe policy, the periodic tick, and the refresh-outcome
// state the policy reads. The 3 h tick mirrors the learned PV forecast's
// cadence and doubles as the retry AND the firmware-upgrade re-probe — Homey
// refreshes its own forecast only about once a day, so nothing faster is
// warranted.
//
// Lives in `lib/solar` rather than the wiring layer because it REMEMBERS: the
// sticky success latch, the first-probe flag and the transition-latched outcome
// are the concept's own state, and `setup/` constructs and connects but does
// not remember (`setup/AGENTS.md` § "No state"). Setup builds this over its SDK
// seams (`setup/appInit/createHomeySolarForecastController.ts`) and hands it over.
//
// SDK-free: every outward seam — the classified per-day fetch, the clock, the
// timezone, the setting read, the learned lane's arm signal — is injected.
//
// No persistence on purpose: Homey caches yesterday/today/tomorrow locally and
// a boot refetch is one cheap local GET, so an in-memory last-good cache is the
// whole story — a persisted copy would add a second staleness policy for zero
// benefit.

import { HomeyEnergySolarForecastSource, summaryHourCount } from './homeyEnergySolarForecast';
import type { SolarForecastDayRead, SolarForecastRefreshOutcome } from './homeyEnergySolarForecast';
import type { PvForecastSourceSetting } from './pvForecastSource';
import { normalizeError } from '../utils/errorUtils';

const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;

/** Minimal structured-log surface (satisfied by the pino logger). */
export type HomeySolarForecastLogger = {
  info: (obj: Record<string, unknown>) => void;
  warn: (obj: Record<string, unknown>) => void;
};

export type HomeySolarForecastControllerCtx = {
  fetchForecastDay: (localDateKey: string) => Promise<SolarForecastDayRead>;
  getTimeZone: () => string;
  getNowMs: () => number;
  /** Resolve the persisted source. Called ONCE at construction and again on the
   *  settings-change event — never per consumer read; see
   *  `setup/pvForecastSourceSetting.ts` for why this key is held, not polled. */
  readSourceSetting: () => PvForecastSourceSetting;
  /** Whether the learned PV lane has seen solar production (the auto-probe arm signal). */
  isLearnedActive: () => boolean;
  logger: HomeySolarForecastLogger;
};

/**
 * Whether the Homey solar-forecast controller exists yet. It is constructed in
 * the post-startup background step, while the settings-change hook and the
 * uninit sweep are wired earlier — so "not started yet" is a real lifecycle
 * state of the app, named here rather than left as an absent field for every
 * reader to null-check.
 */
export type HomeySolarForecastLifecycle =
  | { kind: 'not_started' }
  | { kind: 'started'; controller: HomeySolarForecastController };

export class HomeySolarForecastController {
  readonly source: HomeyEnergySolarForecastSource;
  private timer?: ReturnType<typeof setInterval>;
  // Latched by stop(): a fetch still in flight at app uninit must not drive the
  // completion hook (or any logging) after teardown.
  private stopped = false;
  // Last outcome, kept ONLY for the transition-latched unavailable log below.
  private lastOutcome?: SolarForecastRefreshOutcome;
  // STICKY success latch for the auto probe gate — deliberately not
  // `lastOutcome === 'ok'`: a transient failed refresh overwriting the last
  // outcome must not permanently silence the source (a transient external
  // failure is a no-op, root AGENTS.md).
  private hasSucceeded = false;
  // Whether a CONCLUSIVE probe has run yet; the first auto probe is
  // unconditional. Set on 'ok'/'unavailable' only — see shouldProbe().
  private hasProbed = false;
  // The HELD source setting: resolved once here and re-resolved only when the
  // owner changes it. This controller is the holder because it already
  // remembers and already owns the concept; both forecast consumers read it
  // back through `getSourceSetting()`, so planning and the probe gate can never
  // disagree about which source is selected.
  private sourceSetting: PvForecastSourceSetting;
  // Completion hook, fired only after a refresh that changed the cached
  // forecast — wiring points it at the combined-prices recompute.
  private onRefreshed?: () => void;
  // Serializes overlapping refresh() calls; see the method's note.
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: HomeySolarForecastControllerCtx) {
    this.sourceSetting = ctx.readSourceSetting();
    this.source = new HomeyEnergySolarForecastSource({
      fetchForecastDay: ctx.fetchForecastDay,
      getTimeZone: ctx.getTimeZone,
      getNowMs: ctx.getNowMs,
    });
  }

  /** The selected source, as last resolved. The forecast consumers read the
   *  setting through here rather than the SDK, so one settings read serves the
   *  probe gate, the planning price and the curtailment potential alike. */
  getSourceSetting(): PvForecastSourceSetting {
    return this.sourceSetting;
  }

  /** Re-resolve after the owner changed the setting. Called from the
   *  `[PV_FORECAST_SOURCE]` settings handler, which is the only way this value
   *  changes; the handler kicks `refresh()` straight after. */
  refreshSourceSetting(): void {
    this.sourceSetting = this.ctx.readSourceSetting();
  }

  /** Register the refresh-completion hook (invoked only after the cache changed). */
  setOnRefreshed(callback: () => void): void {
    this.onRefreshed = callback;
  }

  /**
   * Probe policy: an explicit `homey_energy` always fetches; `learned` never
   * does (the source is pinned off, so probing would be waste); `auto` probes
   * unconditionally ONCE (a home whose panels only Homey Energy knows about —
   * no generation feed reaches PELS — must still discover the forecast), then
   * keeps probing while the home shows solar production (the learned lane's
   * arm signal) or a probe has EVER succeeded. The success latch is sticky on
   * purpose — one transient failure must not permanently disarm it. The read
   * is local either way; this gate is a courtesy, not a cost control.
   *
   * The unconditional allowance is spent by a CONCLUSIVE probe (`ok` or
   * `unavailable`), never by a `failed` one. A transient external failure is a
   * no-op (root AGENTS.md), and the home this allowance exists for is exactly
   * the one that cannot re-arm it: `isLearnedActive()` stays false when no
   * generation feed reaches PELS, so letting one flaky first fetch consume the
   * allowance would suppress every later retry until an app restart.
   */
  private shouldProbe(): boolean {
    const setting = this.sourceSetting;
    if (setting === 'homey_energy') return true;
    if (setting === 'learned') return false;
    if (!this.hasProbed) return true;
    return this.ctx.isLearnedActive() || this.hasSucceeded;
  }

  /** Never rejects: every caller is fire-and-forget (start(), the 3 h tick,
   *  the settings kick), so an escaped throw would be an unhandled rejection.
   *  Same guard rationale as `PvForecastController.tryRecoverPersistedState`.
   *  (The probe gate itself no longer reads the SDK — the setting is held — and
   *  the resolve site absorbs a thrown read; this guard covers the fetch path.)
   *
   *  SERIALIZED over `queue`. The three callers are independent — a settings
   *  write can land while the boot fetch or the 3 h tick is still in flight —
   *  and `HomeyEnergySolarForecastSource.refresh` rebuilds the whole per-day
   *  cache from the reads it started with. Two overlapping passes therefore
   *  race on the write: the later-resolving one wins, so an older pass that
   *  resolves `unavailable` after a newer one stored points would wipe them,
   *  and its own stale `hadPoints` would skip the completion hook that tells
   *  the price build the data is gone. Queueing costs nothing (the fetch is a
   *  local GET) and removes the interleaving outright. */
  async refresh(): Promise<void> {
    this.queue = this.queue.then(() => this.refreshGuarded());
    return this.queue;
  }

  private async refreshGuarded(): Promise<void> {
    try {
      await this.refreshInner();
    } catch (error) {
      this.ctx.logger.warn({ event: 'pv_forecast_homey_refresh_failed', err: normalizeError(error) });
    }
  }

  private async refreshInner(): Promise<void> {
    if (this.stopped || !this.shouldProbe()) return;
    const nowMs = this.ctx.getNowMs();
    const hourCountBefore = summaryHourCount(this.source.summarize(nowMs));
    const outcome = await this.source.refresh(nowMs);
    if (this.stopped) return;
    if (outcome === 'ok') this.hasSucceeded = true;
    // Spent by a conclusive answer only — a transient failure is a no-op.
    if (outcome !== 'failed') this.hasProbed = true;
    this.logOutcome(outcome, nowMs);
    this.lastOutcome = outcome;
    // Recompute downstream whenever the cached forecast CHANGED — fresh points
    // landing, and equally a day that went away. Gating the removal case on the
    // whole cache emptying missed the common shape: one day retained through a
    // transient failure while the other is dropped leaves the cache non-empty,
    // so the planning price kept the vanished day's solar adjustment.
    const hourCountAfter = summaryHourCount(this.source.summarize(nowMs));
    if (outcome === 'ok' || hourCountAfter !== hourCountBefore) this.onRefreshed?.();
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.onRefreshed = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private logOutcome(outcome: SolarForecastRefreshOutcome, nowMs: number): void {
    if (outcome === 'ok') {
      // The externally-observable forecast seam — diffable against
      // `pv_forecast_learned` in prod logs to qualify Homey's data.
      this.ctx.logger.info({ event: 'pv_forecast_homey', ...this.source.summarize(nowMs) });
      return;
    }
    if (outcome === 'unavailable' && this.lastOutcome !== 'unavailable') {
      // Transition-latched: 'unavailable' is the steady state on pre-13.4.0
      // firmware and non-solar homes — one line per transition, not 8/day.
      this.ctx.logger.info({ event: 'pv_forecast_homey_unavailable' });
      return;
    }
    if (outcome === 'failed') {
      this.ctx.logger.warn({ event: 'pv_forecast_homey_refresh_failed' });
    }
  }
}
