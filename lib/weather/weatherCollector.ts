import type { Logger as PinoLogger } from 'pino';
import type {
  WeatherAdvisorSettings,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import type { RawHomeyDeviceLike } from '../utils/types';
import { normalizeError } from '../utils/errorUtils';
import {
  getDateKeyInTimeZone,
  getDateKeyStartMs,
  getNextLocalDayStartUtcMs,
  shiftDateKey,
} from '../utils/dateUtils';
import { readDeviceTemperature } from './weatherDeviceRead';
import {
  applyActualSample,
  applyForecastSample,
  CONTROLLED_BACKFILL_VERSION,
  emptyWeatherHistoryState,
  getLocalHourKey,
  KWH_PURGE_VERSION,
  mergeRecoveredState,
  normalizeWeatherHistoryState,
  periodsOverlapWindow,
  reconcileKwhSources,
  rollupDay,
  upsertBackfillRecords,
} from './weatherHistory';
import type { WeatherHistoryStore } from './weatherHistoryStore';
import { fetchBackfillDailyRecords, TEMP_BACKFILL_VERSION } from './weatherInsightsBackfill';
import { resolveMeterDailyKwh, type MeterKwhBackfillOutcome } from './meterKwhBackfill';
import { applyControlledOutcome, resolveControlledDailyKwh } from './controlledKwhBackfill';

const HOUR_MS = 60 * 60 * 1000;
const HOURLY_SAMPLE_OFFSET_MS = 90 * 1000;
const MIDNIGHT_ROLLUP_OFFSET_MS = 5 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 30 * 1000;
const PERSIST_RETRY_MS = 60 * 1000;
/**
 * Window after an absent/implausible settings read during which persisting is
 * refused. A transient SDK miss must not let an empty in-memory state
 * overwrite years of temperature history that cannot be reconstructed
 * (`notes/persisted-settings-state.md`). On a genuinely fresh install this
 * only delays the very first write — harmless.
 */
const LOAD_GRACE_MS = 5 * 60 * 1000;
const CURRENT_TEMP_STALENESS_MS = 2 * HOUR_MS;
const FORECAST_OFFSET_MS = 24 * HOUR_MS;
const READ_WARN_THROTTLE_MS = HOUR_MS;

export type WeatherCollectorDeps = {
  store: WeatherHistoryStore;
  readDevice: (deviceId: string) => Promise<RawHomeyDeviceLike>;
  /** Read-only GET against the Homey Web API (Insights backfills + meter discovery). */
  fetchInsights: (path: string) => Promise<unknown>;
  /** Flat kWh totals for a local day, sourced from the power tracker by the factory. */
  getDailyKwh: (dateKey: string) => { total?: number; controlled?: number; uncontrolled?: number };
  /** Whether PELS manages (controls) a device — drives the historical controlled-split backfill. */
  isManagedDevice: (deviceId: string) => boolean;
  getUnreliablePeriods: () => Array<{ start: number; end: number }>;
  /**
   * Censoring evidence for a local day (PELS-limited comfort/capacity, or a
   * deadline-miss-to-budget), composed by the factory from diagnostics + smart-
   * task history. Absent fields = signal unavailable (treated as unsuppressed).
   */
  getDaySuppression: (dateKey: string) => {
    targetDeficitMs?: number;
    blockedByHeadroomMs?: number;
    deadlineMissedToBudget?: boolean;
  };
  getSettings: () => WeatherAdvisorSettings;
  getNowMs: () => number;
  getTimeZone: () => string;
  /**
   * Recomputes derived fields (energy-signature fit, budget suggestion) after
   * the records change. Injected so the collector stays a pure data layer.
   */
  recomputeDerived?: (state: WeatherHistoryState) => WeatherHistoryState;
  logger: PinoLogger;
};

/**
 * Owns the hidden weather-history collection loop: samples the configured
 * outdoor (and optional forecast) device hourly, finalizes each local day
 * shortly after midnight, and persists through a dirty/debounce/grace cycle.
 * Holds no domain math — the energy-signature fit consumes its records later.
 */
export class WeatherCollector {
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
  private readonly lastWarnAtMsByKey = new Map<string, number>();
  private backfillRunning = false;
  private meterBackfillRunning = false;
  private controlledBackfillRunning = false;
  private running = false;
  /**
   * Bumped on every stop(). Async continuations capture it before awaiting
   * and discard their result on mismatch — `running` alone can't tell "same
   * run" from "a NEW run after a reload", which matters when the reload
   * switched devices mid-read.
   */
  private runGeneration = 0;

  constructor(private readonly deps: WeatherCollectorDeps) {}

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
    this.running = true;
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
      hasForecastDevice: settings.forecastDeviceId !== undefined,
      recordCount: this.state.records.length,
    });
    try {
      this.catchUpRollups();
    } catch (error) {
      // A throwing kWh/period getter must not abort the whole start — the
      // orphaned accumulators get another chance at the next midnight tick.
      this.deps.logger.error({ event: 'weather_rollup_failed', err: normalizeError(error) });
    }
    this.maybeStartBackfill(settings);
    this.maybeStartMeterKwhBackfill();
    this.maybeStartControlledKwhBackfill();
    void this.sampleOnce().catch((error: unknown) => {
      this.deps.logger.warn({ event: 'weather_sample_failed', err: normalizeError(error) });
    });
    this.scheduleNextSample();
    this.scheduleNextRollup();
    return () => this.stop();
  }

  stop(): void {
    if (this.sampleTimer) clearTimeout(this.sampleTimer);
    if (this.rollupTimer) clearTimeout(this.rollupTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.sampleTimer = undefined;
    this.rollupTimer = undefined;
    this.persistTimer = undefined;
    if (this.running) this.flush();
    this.running = false;
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

  /** Whether the one-shot Insights backfill is in flight (UI "backfilling" state). */
  isBackfillRunning(): boolean {
    return this.backfillRunning;
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
    const normalized = normalizeWeatherHistoryState(raw);
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
    const normalized = normalizeWeatherHistoryState(this.deps.store.read());
    if (!normalized) return false;
    this.state = mergeRecoveredState(normalized, this.state);
    this.loadedImplausibleAtMs = undefined;
    this.deps.logger.info({
      event: 'weather_history_state_recovered',
      recordCount: this.state.records.length,
    });
    return true;
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
    if (settings.forecastDeviceId) await this.sampleForecast(settings.forecastDeviceId);
  }

  private async sampleOutdoor(deviceId: string): Promise<void> {
    const generation = this.runGeneration;
    const temperatureC = await this.readTemperature(deviceId, 'outdoor');
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

  // No consumer reads forecastHourly yet (the budget-suggestion stage does);
  // sampling it from PR 1 deliberately production-validates the yr.no
  // period=+24h device path while the feature is still dark, so the
  // suggestion ships against proven data.
  private async sampleForecast(deviceId: string): Promise<void> {
    const generation = this.runGeneration;
    const temperatureC = await this.readTemperature(deviceId, 'forecast');
    if (temperatureC === undefined || generation !== this.runGeneration || !this.running) return;
    const nowMs = this.deps.getNowMs();
    const timeZone = this.deps.getTimeZone();
    const target = new Date(nowMs + FORECAST_OFFSET_MS);
    this.state = applyForecastSample(this.state, {
      targetDateKey: getDateKeyInTimeZone(target, timeZone),
      hourKey: getLocalHourKey(target, timeZone),
      temperatureC,
      todayKey: getDateKeyInTimeZone(new Date(nowMs), timeZone),
    });
    this.markDirty();
  }

  private async readTemperature(
    deviceId: string,
    role: 'outdoor' | 'forecast',
  ): Promise<number | undefined> {
    try {
      const device = await this.deps.readDevice(deviceId);
      const temperatureC = readDeviceTemperature(device);
      if (temperatureC === undefined) {
        this.warnThrottled({ event: 'weather_device_no_temperature', role, deviceId });
      }
      return temperatureC;
    } catch (error) {
      this.warnThrottled({
        event: 'weather_device_read_failed', role, deviceId, err: normalizeError(error),
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
    this.rollupTimer = setTimeout(() => {
      try {
        // Catch-up loop rather than a single yesterday-rollup: if a midnight
        // fire was skipped (clock jump, long stall) the orphaned accumulator
        // would otherwise age past pruning without ever becoming a record.
        this.catchUpRollups();
      } catch (error) {
        this.deps.logger.error({ event: 'weather_rollup_failed', err: normalizeError(error) });
      } finally {
        this.scheduleNextRollup();
      }
    }, Math.max(1000, targetMs - nowMs));
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
    // second-scale synchronous cost by the days slept through.
    if (pendingKeys.length > 0) {
      this.state = this.deps.recomputeDerived?.(this.state) ?? this.state;
      this.markDirty();
    }
  }

  private rollup(dateKey: string): void {
    const timeZone = this.deps.getTimeZone();
    const dayStartMs = getDateKeyStartMs(dateKey, timeZone);
    const nextDayStartMs = getDateKeyStartMs(shiftDateKey(dateKey, 1), timeZone);
    const kwh = this.deps.getDailyKwh(dateKey);
    this.state = rollupDay(this.state, {
      dateKey,
      dayLengthHours: Math.round((nextDayStartMs - dayStartMs) / HOUR_MS),
      kwhTotal: kwh.total,
      kwhControlled: kwh.controlled,
      kwhUncontrolled: kwh.uncontrolled,
      unreliablePower: periodsOverlapWindow(this.deps.getUnreliablePeriods(), dayStartMs, nextDayStartMs),
      suppression: this.deps.getDaySuppression(dateKey),
    });
    this.markDirty();
    const record = this.state.records.find((entry) => entry.dateKey === dateKey);
    this.deps.logger.info({
      event: 'weather_day_rollup',
      dateKey,
      tempMeanC: record?.tempMeanC,
      tempSampleCount: record?.tempSampleCount,
      kwhTotal: record?.kwhTotal,
      quality: record?.quality,
      recordCount: this.state.records.length,
    });
  }

  private maybeStartBackfill(settings: WeatherAdvisorSettings): void {
    const deviceId = settings.outdoorDeviceId;
    if (!deviceId || this.backfillRunning) return;
    // Version-gated: widening the stitched resolution set re-runs the
    // backfill once for already-completed devices (the upsert never
    // overwrites live records, so a re-run is purely additive).
    if (this.state.backfilledDeviceId === deviceId && this.state.backfillVersion === TEMP_BACKFILL_VERSION) return;
    this.backfillRunning = true;
    void fetchBackfillDailyRecords({
      deviceId,
      fetchInsights: this.deps.fetchInsights,
      getDailyKwh: this.deps.getDailyKwh,
      timeZone: this.deps.getTimeZone(),
      nowMs: this.deps.getNowMs(),
    }).then(({ records, complete }) => {
      // A late completion after stop() must not mutate state the next start()
      // will reload over anyway; the unset marker makes that start re-run it.
      if (!this.running) return;
      // The configured device may have changed while this run was in flight;
      // merging the old device's history (or stamping its marker) would
      // record one location's temperatures as another's.
      if (this.deps.getSettings().outdoorDeviceId !== deviceId) {
        this.deps.logger.info({ event: 'weather_backfill_discarded_stale_device', deviceId });
        return;
      }
      // The done-marker requires a complete, non-empty reconstruction. A
      // partial or empty run keeps the marker unset so the next start()
      // retries — a few GETs per boot is cheap insurance against silently
      // forfeiting a year of history to one transient empty response.
      const markDone = complete && records.length > 0;
      // A completed temperature pass changes the record set (new device or a
      // widened stitch), so the kWh layer must re-resolve: drop the meter AND
      // controlled-split markers and let the idempotent backfills run again.
      const {
        meterKwhBackfillDone: _staleDone,
        meterKwhDeviceId: _staleDevice,
        controlledBackfillVersion: _staleControlled,
        ...withoutMeterMarkers
      } = this.state;
      const base = markDone ? withoutMeterMarkers : this.state;
      this.state = {
        ...upsertBackfillRecords(base, records),
        ...(markDone ? { backfilledDeviceId: deviceId, backfillVersion: TEMP_BACKFILL_VERSION } : {}),
      };
      if (records.length > 0) {
        // The backfill is what gives the fit a year of data on day one.
        this.state = this.deps.recomputeDerived?.(this.state) ?? this.state;
      }
      if (records.length > 0 || markDone) this.markDirty();
      this.deps.logger.info({
        event: 'weather_backfill_completed',
        deviceId,
        backfilledDays: records.length,
        complete,
        recordCount: this.state.records.length,
      });
      // Temperature records now exist; resolve their kWh from the meter.
      if (markDone) this.maybeStartMeterKwhBackfill();
    }).catch((error: unknown) => {
      // Marker stays unset, so the next start() retries the backfill.
      this.deps.logger.warn({ event: 'weather_backfill_failed', deviceId, err: normalizeError(error) });
    }).finally(() => {
      this.backfillRunning = false;
      // If the device changed mid-run, kick off the new device's backfill now
      // instead of waiting for the next restart/settings write.
      const current = this.deps.getSettings();
      if (this.running && current.enabled && current.outdoorDeviceId && current.outdoorDeviceId !== deviceId) {
        this.maybeStartBackfill(current);
      }
    });
  }

  /**
   * One-shot historical-kWh resolution from a cumulative meter device,
   * admitted only after its daily diffs match the tracker on the days both
   * cover (`meterKwhBackfill.ts` has the full rationale — the Energy-report
   * source this replaced silently shipped a device-sum subset). The
   * completion reconciles EVERY record's kWh layer, which both fills missing
   * days and purges values from a previously trusted source that no longer
   * validates. No-source outcomes do not latch the marker: a meter added
   * later (or a tracker still too young for 14 overlap days) gets adopted at
   * a subsequent start.
   */
  private maybeStartMeterKwhBackfill(): void {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.outdoorDeviceId) return;
    if (this.meterBackfillRunning) return;
    if (this.state.meterKwhBackfillDone === true) return;
    // Version included: at an upgrade boot the temperature re-stitch is about
    // to rebuild the records and re-chain this flow — starting now too would
    // run the whole REST sweep twice.
    if (this.state.backfilledDeviceId !== settings.outdoorDeviceId
      || this.state.backfillVersion !== TEMP_BACKFILL_VERSION) return;
    this.meterBackfillRunning = true;
    const generationAtLaunch = this.runGeneration;
    void resolveMeterDailyKwh({
      fetchFromHomeyApi: this.deps.fetchInsights,
      getDailyKwh: this.deps.getDailyKwh,
      timeZone: this.deps.getTimeZone(),
      nowMs: this.deps.getNowMs(),
    }).then((result) => {
      if (!this.running || generationAtLaunch !== this.runGeneration) return;
      if (result.outcome !== 'resolved') {
        this.handleMeterNoSource(result);
        return;
      }
      const { state, filledFromMeter, strippedDays, changedDays } = reconcileKwhSources(this.state, {
        getDailyKwh: this.deps.getDailyKwh,
        meterDailyKwh: result.dailyKwh,
        // The legacy purge is one-shot AND requires a complete fetch: a
        // partial fetch may fill but never delete (unread windows would read
        // as "unvouched"), and once the stamp lands, values that age beyond
        // every source's reach are kept rather than mistaken for legacy.
        allowStrip: result.complete && this.state.kwhPurgeVersion !== KWH_PURGE_VERSION,
      });
      this.state = {
        ...state,
        ...(result.complete
          ? { meterKwhBackfillDone: true, meterKwhDeviceId: result.deviceId, kwhPurgeVersion: KWH_PURGE_VERSION }
          : {}),
      };
      if (changedDays > 0) {
        this.state = this.deps.recomputeDerived?.(this.state) ?? this.state;
      }
      if (changedDays > 0 || result.complete) this.markDirty();
      this.deps.logger.info({
        event: 'weather_meter_backfill_completed',
        deviceId: result.deviceId,
        capability: result.capability,
        overlapDays: result.overlapDays,
        medianRatio: result.medianRatio,
        filledFromMeter,
        strippedDays,
        changedDays,
        complete: result.complete,
      });
      // Whole-home totals now exist; reconstruct the controlled/uncontrolled
      // split for those historical days from the managed-device meters.
      if (result.complete) this.maybeStartControlledKwhBackfill();
    }).catch((error: unknown) => {
      // Marker stays unset, so the next start() retries.
      this.deps.logger.warn({ event: 'weather_meter_backfill_failed', err: normalizeError(error) });
    }).finally(() => {
      this.meterBackfillRunning = false;
      // A reload during the (potentially long) fetch superseded this run and
      // its start()-time trigger was blocked by meterBackfillRunning — kick
      // the new run now rather than waiting for the next app restart. Gated
      // on supersession so a persistently failing fetch cannot hot-loop.
      if (this.running && generationAtLaunch !== this.runGeneration) {
        this.maybeStartMeterKwhBackfill();
      }
    });
  }

  /**
   * Even with no successor source, leftovers of the RETIRED unvalidated
   * source must not keep feeding the fit — honest-missing beats
   * silently-wrong. Gated on the election having actually run on evidence:
   * a failed probe means unread data, and unread data must never justify
   * deleting anything. The marker stays unset either way so a later-added
   * meter is adopted.
   */
  private handleMeterNoSource(result: Exclude<MeterKwhBackfillOutcome, { outcome: 'resolved' }>): void {
    const electionConclusive = result.outcome === 'no_candidates' || result.probeFailures === 0;
    // One-shot: tracker-joined backfill kWh is indistinguishable from the
    // legacy class once the tracker's retention passes it, so a recurring
    // strip on no-meter homes would erase legitimate values day by day.
    if (electionConclusive && this.state.kwhPurgeVersion !== KWH_PURGE_VERSION) {
      const { state, strippedDays, changedDays } = reconcileKwhSources(this.state, {
        getDailyKwh: this.deps.getDailyKwh,
        meterDailyKwh: {},
        allowStrip: true,
      });
      this.state = { ...state, kwhPurgeVersion: KWH_PURGE_VERSION };
      this.markDirty();
      if (changedDays > 0) {
        this.state = this.deps.recomputeDerived?.(this.state) ?? this.state;
      }
      if (strippedDays > 0) {
        this.deps.logger.info({ event: 'weather_kwh_legacy_purged', strippedDays });
      }
    }
    this.deps.logger.info({
      event: 'weather_meter_backfill_no_source',
      outcome: result.outcome,
      ...(result.outcome === 'no_comparable_source'
        ? { candidatesChecked: result.candidatesChecked, probeFailures: result.probeFailures }
        : {}),
    });
  }

  /**
   * One-shot reconstruction of the controlled/uncontrolled split for historical
   * (meter-backfilled) days, by summing the managed devices' own cumulative
   * meters. Gated on the whole-home totals existing (`meterKwhBackfillDone`)
   * since uncontrolled = total − controlled, and on its own version marker.
   * Validated median-only against the tracker's controlled totals (flow-mode
   * makes the tracker the noisy reference). A no-devices / not-validated outcome
   * never latches, so a later meter or config gets adopted at a subsequent start.
   */
  private maybeStartControlledKwhBackfill(): void {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.outdoorDeviceId) return;
    if (this.controlledBackfillRunning) return;
    if (this.state.controlledBackfillVersion === CONTROLLED_BACKFILL_VERSION) return;
    if (this.state.meterKwhBackfillDone !== true) return;
    // The temperature backfill must be SETTLED, not about to re-run: a stale
    // version/device started asynchronously in start() will, on completion,
    // clear the meter+controlled markers and re-chain the meter backfill. Were
    // we to start now (on the still-stale `meterKwhBackfillDone`), this run could
    // race that rebuild and stamp the controlled version against soon-to-be-
    // replaced records — and the post-rebuild meter completion would then skip
    // the controlled chain (version already set). Mirror the meter gate so the
    // controlled split runs only once the chain ahead of it is up to date.
    if (this.state.backfilledDeviceId !== settings.outdoorDeviceId
      || this.state.backfillVersion !== TEMP_BACKFILL_VERSION) return;
    this.controlledBackfillRunning = true;
    const generationAtLaunch = this.runGeneration;
    void resolveControlledDailyKwh({
      fetchFromHomeyApi: this.deps.fetchInsights,
      isManaged: this.deps.isManagedDevice,
      getControlledDailyKwh: (dateKey) => this.deps.getDailyKwh(dateKey).controlled,
      timeZone: this.deps.getTimeZone(),
      nowMs: this.deps.getNowMs(),
    }).then((result) => {
      if (!this.running || generationAtLaunch !== this.runGeneration) return;
      const { state, dirty } = applyControlledOutcome({ state: this.state, result, logger: this.deps.logger });
      this.state = state;
      if (dirty) this.markDirty();
    }).catch((error: unknown) => {
      this.deps.logger.warn({ event: 'weather_controlled_backfill_failed', err: normalizeError(error) });
    }).finally(() => {
      this.controlledBackfillRunning = false;
      if (this.running && generationAtLaunch !== this.runGeneration) {
        this.maybeStartControlledKwhBackfill();
      }
    });
  }
}
