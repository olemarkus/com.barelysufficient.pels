import type { WeatherDailyRecord, WeatherHistoryState } from '../../packages/contracts/src/weatherAdvisorTypes';
import { normalizeError } from '../utils/errorUtils';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  shiftDateKey,
} from '../utils/dateUtils';
import { readDeviceTemperature } from './weatherDeviceRead';
import { metRefreshedLogFields, runMetForecastRefresh } from './metForecastRefresh';
import type { WeatherCollectorDeps } from './weatherCollectorDeps';
import {
  applyActualSample,
  emptyWeatherHistoryState,
  getLocalHourKey,
  KWH_PURGE_VERSION,
  mergeRecoveredState,
  normalizeWeatherHistoryState,
  periodsOverlapWindow,
  rollupDay,
  stripMeterScopeDerivedState,
} from './weatherHistory';
import { readMeterScopeDailyKwh } from './weatherMeterScope';
import { WeatherBackfillChain } from './weatherBackfillChain';
import { performBudgetAutoApply } from './weatherAutoApply';
import {
  foldBudgetPressureDay,
  PRESSURE_CEILING_FRACTION,
} from '../../packages/shared-domain/src/energySignature/budgetPressure';

const HOUR_MS = 60 * 60 * 1000;
const HOURLY_SAMPLE_OFFSET_MS = 90 * 1000;
const MIDNIGHT_ROLLUP_OFFSET_MS = 5 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 30 * 1000;
const PERSIST_RETRY_MS = 60 * 1000;
/** Retry a transiently unavailable scope read before any new kWh evidence is admitted. */
const METER_SCOPE_RETRY_MS = 60 * 1000;
/**
 * Window after an absent/implausible settings read during which persisting is
 * refused. A transient SDK miss must not let an empty in-memory state
 * overwrite years of temperature history that cannot be reconstructed
 * (`notes/persisted-settings-state.md`). On a genuinely fresh install this
 * only delays the very first write — harmless.
 */
const LOAD_GRACE_MS = 5 * 60 * 1000;
const CURRENT_TEMP_STALENESS_MS = 2 * HOUR_MS;
const READ_WARN_THROTTLE_MS = HOUR_MS;

export type { WeatherCollectorDeps } from './weatherCollectorDeps';

/**
 * Owns the hidden weather-history collection loop: samples the configured
 * outdoor device hourly, refreshes tomorrow's MET Norway forecast (cache-gated,
 * ≤ hourly per MET ToS), finalizes each local day shortly after midnight, and
 * persists through a dirty/debounce/grace cycle. Holds no domain math — the
 * energy-signature fit consumes its records later.
 */
export class WeatherCollector {
  /**
   * The in-memory history. TWO writers: this class (sampling, rollup, load /
   * recovery) and `WeatherBackfillChain`, which reaches it through the
   * `getState`/`setState` seam handed to it in the constructor. Both run on the
   * same single thread and every transition REPLACES the object rather than
   * mutating it, so a chain continuation that resolves mid-flight overwrites
   * with a value derived from the state it just read. Keep it that way: an
   * in-place mutation on either side would make the two writers race.
   */
  private state: WeatherHistoryState = emptyWeatherHistoryState();
  private dirty = false;
  private loadedImplausibleAtMs?: number;
  private lastTemperatureC?: number;
  /**
   * When the outdoor device was last read successfully. Staleness gates on
   * this, NOT on the capability's `lastUpdated`: Homey only bumps that on
   * value CHANGE, so a flat temperature plateau would otherwise read as
   * "stale" and the covariate would vanish exactly when weather is stable.
   */
  private lastReadingFetchedAtMs?: number;
  private sampleTimer?: ReturnType<typeof setTimeout>;
  private rollupTimer?: ReturnType<typeof setTimeout>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private meterScopeRetryTimer?: ReturnType<typeof setTimeout>;
  /**
   * False while the current run has not resolved its live meter-scope
   * signature. Temperature collection may continue, but every kWh ingress is
   * held until the read heals and the old stamp has been reconciled.
   */
  private meterScopeResolved = false;
  private meterScopeUnavailableLogged = false;
  private readonly lastWarnAtMsByKey = new Map<string, number>();
  /** One-shot temperature → meter kWh → controlled-split chain (`weatherBackfillChain.ts`). */
  private readonly backfillChain: WeatherBackfillChain;
  /** Single-flights the MET refresh so the periodic timer can't overlap the rollup-path one. */
  private metRefreshInFlight = false;
  private running = false;
  /**
   * Bumped on every stop(). Async continuations capture it before awaiting
   * and discard their result on mismatch — `running` alone can't tell "same
   * run" from "a NEW run after a reload", which matters when the reload
   * switched devices mid-read.
   */
  private runGeneration = 0;

  constructor(private readonly deps: WeatherCollectorDeps) {
    this.backfillChain = new WeatherBackfillChain({
      deps,
      getState: () => this.state,
      setState: (state) => { this.state = state; },
      markDirty: () => this.markDirty(),
      isCollectorRunning: () => this.running,
      isMeterScopeResolved: () => this.meterScopeResolved,
      currentRunGeneration: () => this.runGeneration,
    });
  }

  /**
   * (Re)starts the collection loop from current settings. Disabled or
   * unconfigured → registers no timers. Returns the stop callback.
   */
  start(): () => void {
    this.stop();
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.outdoorDeviceId) {
      this.deps.logger.info({ event: 'weather_collector_disabled', enabled: settings.enabled });
      return () => this.stop();
    }
    this.loadState();
    const meterScope = this.reconcileMeterScope();
    this.running = true;
    // Persist either a newly adopted stamp or a forgetting on the restart edge
    // itself, not the 30 s debounce. Without the adoption write, a crash can
    // leave old history unstamped and let the next scope be adopted as if it
    // had produced that history. A normalized pre-stamp blob has no load
    // grace; a genuinely absent/implausible store still keeps the existing
    // grace refusal in `flush()`.
    if (meterScope.persistImmediately) this.flushScopeTransitionWithRetry();
    if (!meterScope.resolved) this.scheduleMeterScopeRetry();
    // States written before the purge stamp existed: a latched validated-
    // meter pass already reconciled (and purged) everything reachable, so
    // the stamp is subsumed — without it, a marker-dropping re-run years
    // later would mistake aged tracker-joined kWh for the legacy class.
    if (this.state.meterKwhBackfillDone === true && this.state.kwhPurgeVersion !== KWH_PURGE_VERSION) {
      this.state = { ...this.state, kwhPurgeVersion: KWH_PURGE_VERSION };
      this.markDirty();
    }
    this.deps.logger.info({
      event: 'weather_collector_started',
      outdoorDeviceId: settings.outdoorDeviceId,
      hasMetForecast: this.deps.fetchForecast !== undefined,
      recordCount: this.state.records.length,
    });
    // Refresh tomorrow's forecast at boot, THEN catch up rollups — so a boot
    // landing after local midnight recomputes/auto-applies on the fresh MET
    // cache rather than a stale-day one (which would fall back to persistence).
    // The fetch is bounded by a timeout, so this cannot stall start() forever;
    // the catch-up is gated on running+generation so a stop() mid-fetch discards
    // it. A throwing kWh/period getter is swallowed inside catchUpRollupsSafely —
    // the orphaned accumulators get another chance at the next midnight tick.
    const generation = this.runGeneration;
    void this.refreshMetForecastSafely().finally(() => {
      if (!this.running || generation !== this.runGeneration) return;
      this.catchUpRollupsSafely();
    });
    this.backfillChain.startTemperatureBackfill(settings);
    this.backfillChain.startMeterKwhBackfill();
    this.backfillChain.startControlledKwhBackfill();
    void this.sampleOnce().catch((error: unknown) => {
      this.deps.logger.warn({ event: 'weather_sample_failed', err: normalizeError(error) });
    });
    this.scheduleNextSample();
    this.scheduleNextRollup();
    return () => this.stop();
  }

  stop(): void {
    this.backfillChain.stop();
    if (this.sampleTimer) clearTimeout(this.sampleTimer);
    if (this.rollupTimer) clearTimeout(this.rollupTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.meterScopeRetryTimer) clearTimeout(this.meterScopeRetryTimer);
    this.sampleTimer = undefined;
    this.rollupTimer = undefined;
    this.persistTimer = undefined;
    this.meterScopeRetryTimer = undefined;
    if (this.running) this.flush();
    this.running = false;
    this.meterScopeResolved = false;
    this.meterScopeUnavailableLogged = false;
    this.runGeneration += 1;
    // The covariate must not outlive an active collector: after a
    // disable-reload the power-sample path keeps asking for the temperature,
    // and a cached value would stamp weather onto observations for up to the
    // staleness window. An enabled restart re-samples within milliseconds.
    this.lastTemperatureC = undefined;
    this.lastReadingFetchedAtMs = undefined;
  }

  /** Latest outdoor reading, for stamping covariates; undefined when the device went unreadable. */
  getCurrentOutdoorTemperatureC(): number | undefined {
    if (this.lastTemperatureC === undefined || this.lastReadingFetchedAtMs === undefined) return undefined;
    if (this.deps.getNowMs() - this.lastReadingFetchedAtMs > CURRENT_TEMP_STALENESS_MS) return undefined;
    return this.lastTemperatureC;
  }

  /**
   * Live in-memory history snapshot for the settings-UI readout. Read-only by
   * contract: the state object is immutable-by-convention (every transition
   * replaces it), so handing out the reference is safe. Fresher than the
   * persisted blob, which lags behind the dirty/debounce cycle by up to 30 s.
   */
  getHistoryStateSnapshot(): WeatherHistoryState {
    return this.state;
  }

  /**
   * Whether any stage of the one-shot backfill chain — temperature → meter kWh
   * → controlled split — is in flight; drives the UI "backfilling" state. All
   * three stages rewrite the record set the energy-signature fit reads, and the
   * fit is now computed only once the kWh layer settles (mid-to-late in the
   * chain), so the UI must read as backfilling until the whole chain quiesces,
   * not just during the temperature pass. (When a prior fit already exists — a
   * redeploy re-running the chain — the readout still shows that fit as `ready`;
   * this only flips the no-fit-yet state from `learning` to `backfilling`.)
   */
  isBackfillRunning(): boolean {
    return this.backfillChain.isRunning();
  }

  /** Persist immediately, bypassing the debounce (shutdown path). Still honors the load grace. */
  flush(): void {
    if (!this.dirty) return;
    if (this.loadedImplausibleAtMs !== undefined && !this.tryRecoverPersistedState()) {
      if (this.isLoadGraceActive()) {
        this.deps.logger.warn({ event: 'weather_history_flush_skipped_grace' });
        return;
      }
    }
    this.writeState();
  }

  private loadState(): void {
    const raw = this.deps.store.read();
    const normalized = normalizeWeatherHistoryState(raw, this.getCurrentDateKey());
    if (normalized) {
      this.state = normalized;
      this.loadedImplausibleAtMs = undefined;
      return;
    }
    this.state = emptyWeatherHistoryState();
    this.loadedImplausibleAtMs = this.deps.getNowMs();
    if (raw === undefined || raw === null) {
      this.deps.logger.info({ event: 'weather_history_state_absent' });
    } else {
      this.deps.logger.warn({ event: 'weather_history_state_implausible' });
    }
  }

  /**
   * Compares the stamped meter-scope signature against the live whole-home
   * metering arrangement and, on a mismatch, forgets every meter-derived field
   * (`stripMeterScopeDerivedState`) — the kWh history behind the energy
   * signature would otherwise mix data from different meter arrangements.
   * Collector-owned by necessity: an outside store-only clear is inert,
   * because the next start() begins with stop() → flush(), which writes the
   * unforgetting in-memory blob back over the store before reloading. Runs
   * after every state load and after a grace-window recovery merge (which
   * deliberately resurrects the recovered markers and stamp), so a settings
   * event missed while the collector was down self-heals at the next start.
   * Epistemics: an unavailable signature read keeps the stamp untouched, and
   * a pre-stamp blob adopts the current signature without forgetting —
   * neither is evidence the arrangement actually changed.
   * Returns whether the live scope was resolved, whether anything was
   * forgotten, and whether the resulting stamp transition must be flushed
   * immediately.
   */
  private reconcileMeterScope(): {
    resolved: boolean;
    invalidated: boolean;
    persistImmediately: boolean;
  } {
    const signature = this.deps.readMeterScopeSignature();
    if (signature === undefined) {
      this.meterScopeResolved = false;
      if (!this.meterScopeUnavailableLogged) {
        this.meterScopeUnavailableLogged = true;
        this.deps.logger.info({ event: 'weather_meter_scope_reconcile_deferred' });
      }
      return { resolved: false, invalidated: false, persistImmediately: false };
    }
    this.meterScopeResolved = true;
    this.meterScopeUnavailableLogged = false;
    if (this.state.meterScopeSignature === signature) {
      return { resolved: true, invalidated: false, persistImmediately: false };
    }
    const previous = this.state.meterScopeSignature;
    if (previous === undefined) {
      this.state = { ...this.state, meterScopeSignature: signature };
      this.markDirty();
      return {
        resolved: true,
        invalidated: false,
        // A normalized pre-stamp history must be stamped durably now. When
        // the history read itself was absent/implausible, keep the existing
        // recovery grace; `tryRecoverPersistedState` re-reconciles and the
        // caller writes the recovered state immediately.
        persistImmediately: this.loadedImplausibleAtMs === undefined,
      };
    }
    const hadMeterBackfill = this.state.meterKwhBackfillDone === true;
    const hadFit = this.state.latestFit !== undefined;
    const meterScopeSinceDateKey = getDateKeyInTimeZone(
      new Date(this.deps.getNowMs()),
      this.deps.getTimeZone(),
    );
    this.state = {
      ...stripMeterScopeDerivedState(this.state),
      meterScopeSignature: signature,
      meterScopeSinceDateKey,
    };
    this.markDirty();
    this.deps.logger.info({
      event: 'weather_meter_scope_invalidated',
      reason: 'meter_scope_changed',
      previousSignature: previous,
      currentSignature: signature,
      hadMeterBackfill,
      hadFit,
    });
    return { resolved: true, invalidated: true, persistImmediately: true };
  }

  /**
   * Retries indefinitely at a bounded cadence: one unavailable settings read
   * must not become the run's permanent answer. Until it heals,
   * `meterScopeResolved` fences tracker reads and both historical-kWh stages.
   */
  private scheduleMeterScopeRetry(): void {
    if (!this.running || this.meterScopeRetryTimer) return;
    this.meterScopeRetryTimer = setTimeout(() => {
      this.meterScopeRetryTimer = undefined;
      if (!this.running) return;
      const outcome = this.reconcileMeterScope();
      if (!outcome.resolved) {
        this.scheduleMeterScopeRetry();
        return;
      }
      if (outcome.persistImmediately) this.flushScopeTransitionWithRetry();
      // Boot catch-up stays pending while the scope is unknown: rolling an
      // accumulator without its tracker kWh would permanently consume it as a
      // missing-kWh record. Recovery is the first safe point to retry.
      this.catchUpRollupsSafely();
      // A temperature backfill may have settled while kWh admission was held;
      // resume both downstream stages now instead of waiting for a restart.
      this.backfillChain.startMeterKwhBackfill();
      this.backfillChain.startControlledKwhBackfill();
      this.deps.logger.info({
        event: 'weather_meter_scope_reconcile_recovered',
        invalidated: outcome.invalidated,
      });
    }, METER_SCOPE_RETRY_MS);
  }

  private isLoadGraceActive(): boolean {
    return this.loadedImplausibleAtMs !== undefined
      && this.deps.getNowMs() - this.loadedImplausibleAtMs < LOAD_GRACE_MS;
  }

  private markDirty(): void {
    this.dirty = true;
    // A late in-flight sample can land after stop(); don't re-arm timers on a
    // stopped collector — the data is one sample, accepted as lost.
    if (!this.running || this.persistTimer) return;
    this.schedulePersist(PERSIST_DEBOUNCE_MS);
  }

  private schedulePersist(delayMs: number): void {
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistIfDue();
    }, delayMs);
  }

  /** Immediate scope writes retain their normal retry path when persistence fails. */
  private flushScopeTransitionWithRetry(): void {
    this.flush();
    if (this.dirty && !this.persistTimer) this.schedulePersist(PERSIST_RETRY_MS);
  }

  private persistIfDue(): void {
    if (!this.dirty) return;
    // While the boot read was absent/implausible, every persist attempt first
    // re-reads the store: a transient SDK miss usually heals within seconds,
    // and adopting the recovered blob (merging the few in-memory samples onto
    // it) is the only way a miss does NOT end in overwriting irreplaceable
    // history. Emptiness is accepted only after every retry across the grace
    // window came back unreadable.
    if (this.loadedImplausibleAtMs !== undefined && !this.tryRecoverPersistedState()) {
      if (this.isLoadGraceActive()) {
        this.schedulePersist(PERSIST_RETRY_MS);
        return;
      }
    }
    this.writeState();
    if (this.dirty) this.schedulePersist(PERSIST_RETRY_MS);
  }

  /** Re-reads the store after a failed boot read; merges and clears the grace on success. */
  private tryRecoverPersistedState(): boolean {
    const normalized = normalizeWeatherHistoryState(this.deps.store.read(), this.getCurrentDateKey());
    if (!normalized) return false;
    this.state = mergeRecoveredState(normalized, this.state);
    this.loadedImplausibleAtMs = undefined;
    // The merge adopts the recovered blob's meter markers and scope stamp
    // wholesale; if the arrangement changed while the store was unreadable,
    // forget them again before the caller persists the merged state.
    const meterScope = this.reconcileMeterScope();
    if (!meterScope.resolved) this.scheduleMeterScopeRetry();
    if (meterScope.resolved) {
      this.backfillChain.startMeterKwhBackfill();
      this.backfillChain.startControlledKwhBackfill();
    }
    this.deps.logger.info({
      event: 'weather_history_state_recovered',
      recordCount: this.state.records.length,
    });
    return true;
  }

  private getCurrentDateKey(): string {
    return getDateKeyInTimeZone(
      new Date(this.deps.getNowMs()),
      this.deps.getTimeZone(),
    );
  }

  private writeState(): void {
    try {
      this.deps.store.write(this.state);
      this.dirty = false;
      // Once a write lands, the store reflects memory; a later "recovery"
      // re-read could only regress to this (or an older) snapshot.
      this.loadedImplausibleAtMs = undefined;
    } catch (error) {
      this.deps.logger.error({ event: 'weather_history_persist_failed', err: normalizeError(error) });
    }
  }

  private async sampleOnce(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.outdoorDeviceId) return;
    await this.sampleOutdoor(settings.outdoorDeviceId);
    // Reuse the hourly sample cadence for the MET refresh; it is cache-gated by
    // the `Expires` header so an in-window cache means no network call (≤ hourly
    // per MET ToS regardless of how often this fires).
    await this.refreshMetForecast();
  }

  private async sampleOutdoor(deviceId: string): Promise<void> {
    const generation = this.runGeneration;
    const temperatureC = await this.readTemperature(deviceId);
    // A late-resolving read must not mutate a stopped collector — nor a NEW
    // run that may have switched to a different outdoor device.
    if (temperatureC === undefined || generation !== this.runGeneration || !this.running) return;
    this.lastTemperatureC = temperatureC;
    this.lastReadingFetchedAtMs = this.deps.getNowMs();
    const nowMs = this.deps.getNowMs();
    const timeZone = this.deps.getTimeZone();
    const now = new Date(nowMs);
    this.state = applyActualSample(this.state, {
      dateKey: getDateKeyInTimeZone(now, timeZone),
      hourKey: getLocalHourKey(now, timeZone),
      temperatureC,
    });
    this.markDirty();
  }

  /** Single-flights `runMetForecastRefresh` (the cache-gate + fetch + fallback chain live in that module). */
  private async refreshMetForecast(): Promise<void> {
    if (!this.deps.fetchForecast || this.metRefreshInFlight) return;
    this.metRefreshInFlight = true;
    const generation = this.runGeneration;
    try {
      const todayKey = (): string => getDateKeyInTimeZone(new Date(this.deps.getNowMs()), this.deps.getTimeZone());
      await runMetForecastRefresh({
        fetchForecast: this.deps.fetchForecast,
        getCache: () => this.state.metForecast,
        getNowMs: () => this.deps.getNowMs(),
        getTodayKey: todayKey,
        getTomorrowKey: () => shiftDateKey(todayKey(), 1),
        isStillCurrent: () => generation === this.runGeneration && this.running,
        storeCache: (cache) => { this.state = { ...this.state, metForecast: cache }; this.markDirty(); },
        logRefreshed: (cache) => this.deps.logger.info(metRefreshedLogFields(cache)),
        warnUnavailable: (outcome) => this.warnThrottled({ event: 'weather_met_forecast_unavailable', outcome }),
      });
    } finally {
      this.metRefreshInFlight = false;
      // A reload during the (timeout-bounded) fetch superseded this run, and the
      // new run's start()-time refresh was blocked by the in-flight flag. Kick
      // the new run's refresh now rather than waiting for its next sample/rollup
      // tick. Gated on supersession so a persistently-failing fetch cannot
      // hot-loop (mirrors the meter/controlled backfill re-kick pattern).
      if (this.running && generation !== this.runGeneration) {
        void this.refreshMetForecast();
      }
    }
  }

  private async readTemperature(deviceId: string): Promise<number | undefined> {
    try {
      const device = await this.deps.readDevice(deviceId);
      const temperatureC = readDeviceTemperature(device);
      if (temperatureC === undefined) {
        this.warnThrottled({ event: 'weather_device_no_temperature', role: 'outdoor', deviceId });
      }
      return temperatureC;
    } catch (error) {
      this.warnThrottled({
        event: 'weather_device_read_failed', role: 'outdoor', deviceId, err: normalizeError(error),
      });
      return undefined;
    }
  }

  private warnThrottled(payload: { event: string; role?: string } & Record<string, unknown>): void {
    const nowMs = this.deps.getNowMs();
    const key = `${payload.event}:${payload.role ?? ''}`;
    const lastAtMs = this.lastWarnAtMsByKey.get(key) ?? 0;
    if (nowMs - lastAtMs < READ_WARN_THROTTLE_MS) return;
    this.lastWarnAtMsByKey.set(key, nowMs);
    this.deps.logger.warn(payload);
  }

  private scheduleNextSample(): void {
    // A fired timer's in-flight sampleOnce can outlive stop() (it awaits a
    // REST read); without this guard its `.finally` would re-arm a second,
    // untracked hourly chain after every reload-during-read.
    if (!this.running) return;
    const nowMs = this.deps.getNowMs();
    const nextTopOfHour = (Math.floor(nowMs / HOUR_MS) + 1) * HOUR_MS;
    const delayMs = Math.max(1000, nextTopOfHour + HOURLY_SAMPLE_OFFSET_MS - nowMs);
    if (this.sampleTimer) clearTimeout(this.sampleTimer);
    this.sampleTimer = setTimeout(() => {
      void this.sampleOnce()
        .catch((error: unknown) => {
          this.deps.logger.warn({ event: 'weather_sample_failed', err: normalizeError(error) });
        })
        .finally(() => this.scheduleNextSample());
    }, delayMs);
  }

  private scheduleNextRollup(): void {
    if (!this.running) return;
    const nowMs = this.deps.getNowMs();
    const timeZone = this.deps.getTimeZone();
    const targetMs = getNextLocalDayStartUtcMs(nowMs, timeZone) + MIDNIGHT_ROLLUP_OFFSET_MS;
    if (this.rollupTimer) clearTimeout(this.rollupTimer);
    // Capture the generation so a stop() (or a new run) during the awaited
    // refresh discards this continuation: without it, the catch-up would mutate
    // state and reschedule a timer on a stopped/superseded collector.
    const generation = this.runGeneration;
    this.rollupTimer = setTimeout(() => {
      // Refresh tomorrow's forecast BEFORE the catch-up recompute so the midnight
      // suggestion is built on a fresh complete MET profile (cache-gated, so an
      // in-window cache is a no-op). A refresh failure must not skip the rollup —
      // the suggestion then falls back to persistence.
      void this.refreshMetForecastSafely().finally(() => {
        if (!this.running || generation !== this.runGeneration) return;
        this.catchUpRollupsSafely();
        this.scheduleNextRollup();
      });
    }, Math.max(1000, targetMs - nowMs));
  }

  /** refreshMetForecast wrapped so a transient failure logs instead of rejecting the caller. */
  private async refreshMetForecastSafely(): Promise<void> {
    try {
      await this.refreshMetForecast();
    } catch (error) {
      this.deps.logger.warn({ event: 'weather_met_forecast_refresh_failed', err: normalizeError(error) });
    }
  }

  /**
   * Catch-up loop rather than a single yesterday-rollup: if a midnight fire was
   * skipped (clock jump, long stall) the orphaned accumulator would otherwise
   * age past pruning without ever becoming a record. Swallows getter throws so
   * one bad day cannot abort boot or the rollup timer.
   */
  private catchUpRollupsSafely(): void {
    if (!this.meterScopeResolved) return;
    try {
      this.catchUpRollups();
    } catch (error) {
      this.deps.logger.error({ event: 'weather_rollup_failed', err: normalizeError(error) });
    }
  }

  /** Roll any accumulator days the app slept through (boot catch-up). */
  private catchUpRollups(): void {
    const todayKey = getDateKeyInTimeZone(new Date(this.deps.getNowMs()), this.deps.getTimeZone());
    const pendingKeys = Object.keys(this.state.accumulators ?? {})
      .filter((dateKey) => dateKey < todayKey)
      .sort();
    for (const dateKey of pendingKeys) this.rollup(dateKey);
    // One refit for the whole batch: the Theil–Sen fit is O(n²) over a
    // year-deep window, so refitting per caught-up day would multiply a
    // second-scale synchronous cost by the days slept through. Then apply the
    // fresh suggestion to the daily budget once if opted in (never per caught-up
    // day — the suggestion targets the just-started day).
    if (pendingKeys.length > 0) {
      this.state = performBudgetAutoApply(this.deps.recomputeDerived?.(this.state) ?? this.state, this.deps);
      this.markDirty();
    }
  }

  /**
   * The daily budget setting only still describes `dateKey` while that day is
   * the one that just closed: the normal 00:05 rollup runs BEFORE auto-apply
   * writes the new day's number. A boot catch-up rolling up days further back
   * would read a budget that has since moved, so it reports nothing rather than
   * stamping a wrong one. The pressure loop then HOLDS that day: an unmeasurable
   * day is not evidence in either direction, so it must neither grow nor decay.
   */
  private resolveAppliedBudgetKwh(dateKey: string): number | undefined {
    const todayKey = getDateKeyInTimeZone(new Date(this.deps.getNowMs()), this.deps.getTimeZone());
    if (dateKey !== shiftDateKey(todayKey, -1)) return undefined;
    return this.deps.getAppliedDailyBudgetKwh();
  }

  /**
   * Folds a just-closed day into the budget-pressure loop. Called from `rollup`
   * and NOWHERE else: this is the single point a day genuinely closes. Doing it
   * in the derived recompute would also run it on the backfill chain's refits,
   * where records carry no suppression evidence and would silently leak live
   * evidence away.
   */
  private foldClosedDayIntoBudgetPressure(record: WeatherDailyRecord): void {
    // Bound the integral by what the suggestion could actually apply, using the
    // prediction from the previous recompute (the refit runs after this batch).
    const predictedKwh = this.state.latestSuggestion?.predictedKwh;
    this.state = {
      ...this.state,
      budgetPressure: foldBudgetPressureDay(
        this.state.budgetPressure,
        record,
        predictedKwh !== undefined ? PRESSURE_CEILING_FRACTION * predictedKwh : undefined,
      ),
    };
  }

  private rollup(dateKey: string): void {
    const timeZone = this.deps.getTimeZone();
    const dayStartMs = getDateKeyStartMs(dateKey, timeZone);
    const nextDayStartMs = getDateKeyStartMs(shiftDateKey(dateKey, 1), timeZone);
    const kwh = this.meterScopeResolved
      ? readMeterScopeDailyKwh(this.state, dateKey, this.deps.getDailyKwh)
      : {};
    this.state = rollupDay(this.state, {
      dateKey,
      dayLengthHours: Math.round((nextDayStartMs - dayStartMs) / HOUR_MS),
      kwhTotal: kwh.total,
      kwhControlled: kwh.controlled,
      kwhUncontrolled: kwh.uncontrolled,
      unreliablePower: periodsOverlapWindow(this.deps.getUnreliablePeriods(), dayStartMs, nextDayStartMs),
      suppression: this.deps.getDaySuppression(dateKey),
      appliedBudgetKwh: this.resolveAppliedBudgetKwh(dateKey),
    });
    const record = this.state.records.find((entry) => entry.dateKey === dateKey);
    if (record) this.foldClosedDayIntoBudgetPressure(record);
    this.markDirty();
    this.deps.logger.info({
      event: 'weather_day_rollup',
      dateKey,
      tempMeanC: record?.tempMeanC,
      tempSampleCount: record?.tempSampleCount,
      kwhTotal: record?.kwhTotal,
      quality: record?.quality,
      appliedBudgetKwh: record?.appliedBudgetKwh ?? null,
      // The day-close damage verdict: null = no witness (restart/gap across
      // midnight), 0 = watched to the close and nothing denied.
      budgetDeniedKwh: record?.suppression?.budgetDeniedKwh ?? null,
      budgetPressureKwh: this.state.budgetPressure?.kwh ?? 0,
      recordCount: this.state.records.length,
    });
  }
}
