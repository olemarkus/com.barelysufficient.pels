/**
 * The one-shot historical backfill chain — temperature → meter kWh →
 * controlled/uncontrolled split — sliced out of `weatherCollector.ts` to keep
 * that entry point under the line budget.
 *
 * The three stages run at most once per install (each latches its own version /
 * done marker in the persisted state) and rewrite the record set the
 * energy-signature fit reads. They are chained: a completed temperature pass
 * drops the downstream markers and restarts the meter pass, and a complete
 * meter pass starts the controlled split. Every stage re-checks
 * `host.isCollectorRunning()` and the run generation before mutating state, so a
 * `stop()` (or a reload that switched devices) discards a late continuation.
 */
import type {
  WeatherAdvisorSettings,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import { normalizeError } from '../utils/errorUtils';
import {
  CONTROLLED_BACKFILL_VERSION,
  KWH_PURGE_VERSION,
  reconcileKwhSources,
  upsertBackfillRecords,
} from './weatherHistory';
import { readMeterScopeDailyKwh } from './weatherMeterScope';
import { fetchBackfillDailyRecords, TEMP_BACKFILL_VERSION } from './weatherInsightsBackfill';
import { resolveMeterDailyKwh, type MeterKwhBackfillOutcome } from './meterKwhBackfill';
import { applyControlledOutcome, resolveControlledDailyKwh } from './controlledKwhBackfill';
import type { WeatherCollectorDeps } from './weatherCollectorDeps';

const METER_SETTINGS_RETRY_MS = 60_000;

/**
 * The slice of `WeatherCollectorDeps` the chain reads. Enumerated rather than
 * taking the whole bag so the chain has no type-level reach into the
 * persistence port (`store`), the daily-budget write seam
 * (`applySuggestedDailyBudget`), the MET fetch, or the device read.
 * `WeatherCollectorDeps` stays assignable, so the collector passes its own.
 */
export type WeatherBackfillDeps = Pick<
  WeatherCollectorDeps,
  | 'readMeterInventory'
  | 'fetchInsights'
  | 'getDailyKwh'
  | 'getNowMs'
  | 'getSettings'
  | 'getTimeZone'
  | 'isManagedDevice'
  | 'logger'
  | 'readMainMeterSelection'
  | 'readMeterScopeSignature'
  | 'readPowerSource'
  | 'recomputeDerived'
>;

/**
 * The collector surface the chain drives. Declared structurally so this module
 * never imports the collector back; `WeatherCollector` passes a small adapter.
 * `currentRunGeneration()` is read fresh on every continuation — comparing it
 * against the value captured at launch is how a superseded run is discarded.
 */
export type WeatherBackfillHost = {
  readonly deps: WeatherBackfillDeps;
  getState: () => WeatherHistoryState;
  setState: (state: WeatherHistoryState) => void;
  markDirty: () => void;
  isCollectorRunning: () => boolean;
  isMeterScopeResolved: () => boolean;
  currentRunGeneration: () => number;
};

export class WeatherBackfillChain {
  private temperatureRunning = false;
  private meterRunning = false;
  private controlledRunning = false;
  private meterSettingsRetryTimer?: ReturnType<typeof setTimeout>;
  // A legacy install with no chosen meter stays `unavailable` until its owner
  // picks one, and the 60 s retry keeps running for as long as it does; log
  // the deferral once per unavailable stretch, not once per retry.
  private meterSelectionUnavailableLogged = false;

  constructor(private readonly host: WeatherBackfillHost) {}

  private get deps(): WeatherBackfillDeps {
    return this.host.deps;
  }

  private readScopeDailyKwh(dateKey: string): ReturnType<WeatherBackfillDeps['getDailyKwh']> {
    if (!this.host.isMeterScopeResolved()) return {};
    return readMeterScopeDailyKwh(this.host.getState(), dateKey, this.deps.getDailyKwh);
  }

  /** True while any stage of the chain is in flight; drives the UI "backfilling" state. */
  isRunning(): boolean {
    return this.temperatureRunning || this.meterRunning || this.controlledRunning;
  }

  stop(): void {
    if (this.meterSettingsRetryTimer) clearTimeout(this.meterSettingsRetryTimer);
    this.meterSettingsRetryTimer = undefined;
  }

  private scheduleMeterSettingsRetry(): void {
    if (this.meterSettingsRetryTimer) return;
    this.meterSettingsRetryTimer = setTimeout(() => {
      this.meterSettingsRetryTimer = undefined;
      if (this.host.isCollectorRunning()) this.startMeterKwhBackfill();
    }, METER_SETTINGS_RETRY_MS);
  }

  /**
   * Recompute the energy-signature fit/suggestion from records the caller has
   * established are settled (the kWh layer will not change further), and mark
   * the state for persistence so the refreshed fit survives a restart. Called
   * only from the stages that own the settled-kWh guarantee — never the
   * temperature stage, whose records are still missing historical kWh.
   */
  private refitFromSettledRecords(): void {
    this.host.setState(this.deps.recomputeDerived(this.host.getState()));
    this.host.markDirty();
  }

  startTemperatureBackfill(settings: WeatherAdvisorSettings): void {
    const deviceId = settings.outdoorDeviceId;
    if (!deviceId || this.temperatureRunning) return;
    const state = this.host.getState();
    // Version-gated: widening the stitched resolution set re-runs the
    // backfill once for already-completed devices (the upsert never
    // overwrites live records, so a re-run is purely additive).
    if (state.backfilledDeviceId === deviceId && state.backfillVersion === TEMP_BACKFILL_VERSION) return;
    this.temperatureRunning = true;
    const generationAtLaunch = this.host.currentRunGeneration();
    void fetchBackfillDailyRecords({
      deviceId,
      fetchInsights: this.deps.fetchInsights,
      getDailyKwh: (dateKey) => this.readScopeDailyKwh(dateKey),
      timeZone: this.deps.getTimeZone(),
      nowMs: this.deps.getNowMs(),
    }).then(({ records, complete }) => {
      // A late completion after stop() must not mutate state the next start()
      // will reload over anyway; the unset marker makes that start re-run it.
      if (
        !this.host.isCollectorRunning()
        || generationAtLaunch !== this.host.currentRunGeneration()
      ) return;
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
      const current = this.host.getState();
      const {
        meterKwhBackfillDone: _staleDone,
        meterKwhDeviceId: _staleDevice,
        controlledBackfillVersion: _staleControlled,
        ...withoutMeterMarkers
      } = current;
      const base = markDone ? withoutMeterMarkers : current;
      this.host.setState({
        ...upsertBackfillRecords(base, records),
        ...(markDone ? { backfilledDeviceId: deviceId, backfillVersion: TEMP_BACKFILL_VERSION } : {}),
      });
      // The temperature stage deliberately does NOT refit here. The records it
      // just upserted carry kWh only for the recent days the power tracker still
      // retains; the older days stay kWh-less until the meter backfill chained
      // below resolves them. A fit now would be built on that recent-only usable
      // subset (in summer, a warm-skewed low-R² signature) and then persisted,
      // logged as `weather_advisor_fit`, and — with auto-apply on — pushed to the
      // daily budget. The refit happens once the kWh layer settles: at the
      // meter-resolved stage, or in handleMeterNoSource when no meter exists.
      if (records.length > 0 || markDone) this.host.markDirty();
      this.deps.logger.info({
        event: 'weather_backfill_completed',
        deviceId,
        backfilledDays: records.length,
        complete,
        recordCount: this.host.getState().records.length,
      });
      // Temperature records now exist; resolve their kWh from the meter.
      if (markDone) this.startMeterKwhBackfill();
    }).catch((error: unknown) => {
      // Marker stays unset, so the next start() retries the backfill.
      this.deps.logger.warn({ event: 'weather_backfill_failed', deviceId, err: normalizeError(error) });
    }).finally(() => {
      this.temperatureRunning = false;
      // If the run was superseded (including a same-device meter/source
      // reload), or the device changed mid-run, kick off a fresh backfill now
      // instead of waiting for the next restart/settings write. A stale
      // completion may already carry tracker kWh joined under the old scope,
      // so it must never land in the new run.
      const current = this.deps.getSettings();
      if (
        this.host.isCollectorRunning()
        && current.enabled
        && current.outdoorDeviceId
        && (
          generationAtLaunch !== this.host.currentRunGeneration()
          || current.outdoorDeviceId !== deviceId
        )
      ) {
        this.startTemperatureBackfill(current);
      }
    });
  }

  /**
   * Recover daily kWh from Main's selected meter. Keep retrying on subsequent
   * starts until a complete read supplies usable history.
   */
  startMeterKwhBackfill(): void {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.outdoorDeviceId) return;
    if (this.meterRunning) return;
    if (!this.host.isMeterScopeResolved()) return;
    const state = this.host.getState();
    if (state.meterKwhBackfillDone === true) return;
    // Version included: at an upgrade boot the temperature re-stitch is about
    // to rebuild the records and re-chain this flow — starting now too would
    // run the whole REST sweep twice.
    if (state.backfilledDeviceId !== settings.outdoorDeviceId
      || state.backfillVersion !== TEMP_BACKFILL_VERSION) return;
    // Flow readings have no known producing meter. An unread source setting
    // defers the backfill until its producer is known.
    const powerSource = this.deps.readPowerSource();
    if (powerSource.state === 'suspect') {
      this.deps.logger.info({ event: 'weather_meter_backfill_deferred_source_unavailable' });
      this.scheduleMeterSettingsRetry();
      return;
    }
    if (powerSource.value === 'flow') {
      this.handleMeterNoSource('flow_source');
      return;
    }
    // Only the currently selected meter supplies history for this scope.
    const mainMeter = this.deps.readMainMeterSelection();
    if (mainMeter.state !== 'resolved') {
      if (!this.meterSelectionUnavailableLogged) {
        this.deps.logger.info({
          event: 'weather_meter_backfill_deferred_selection_unavailable',
          reason: mainMeter.state,
        });
      }
      this.meterSelectionUnavailableLogged = true;
      // Poll only for a read that might yet succeed. With no meter chosen the
      // marker simply stays unset and the next `start()` — after the owner
      // picks one — starts the backfill.
      if (mainMeter.state === 'unavailable') this.scheduleMeterSettingsRetry();
      return;
    }
    this.meterSelectionUnavailableLogged = false;
    this.meterRunning = true;
    const generationAtLaunch = this.host.currentRunGeneration();
    const scopeAtLaunch = state.meterScopeSignature;
    void resolveMeterDailyKwh({
      readMeterInventory: this.deps.readMeterInventory,
      fetchFromHomeyApi: this.deps.fetchInsights,
      getDailyKwh: (dateKey) => this.readScopeDailyKwh(dateKey),
      restrictToDeviceId: mainMeter.meterDeviceId,
      timeZone: this.deps.getTimeZone(),
      nowMs: this.deps.getNowMs(),
    }).then((result) => {
      if (!this.host.isCollectorRunning() || generationAtLaunch !== this.host.currentRunGeneration()) return;
      // Settings can already name another meter while its collector reload
      // waits in the settings queue.
      const liveScope = this.deps.readMeterScopeSignature();
      if (liveScope === undefined) {
        this.scheduleMeterSettingsRetry();
        return;
      }
      if (liveScope !== scopeAtLaunch) return;
      if (result.outcome === 'unreadable_history') {
        this.deps.logger.warn({ event: 'weather_meter_backfill_failed', reason: result.outcome });
        return;
      }
      if (result.outcome !== 'resolved') {
        this.handleMeterNoSource(result.outcome);
        return;
      }
      const current = this.host.getState();
      const completePolicy = current.kwhPurgeVersion === KWH_PURGE_VERSION ? 'refresh' : 'refresh_and_purge_legacy';
      const { state: reconciled, filledFromMeter, strippedDays, changedDays } = reconcileKwhSources(current, {
        getDailyKwh: (dateKey) => this.readScopeDailyKwh(dateKey),
        meterDailyKwh: result.dailyKwh,
        meterPolicy: result.complete ? completePolicy : 'fill_missing',
      });
      this.host.setState({
        ...reconciled,
        ...(result.complete
          ? { meterKwhBackfillDone: true, meterKwhDeviceId: result.deviceId, kwhPurgeVersion: KWH_PURGE_VERSION }
          : {}),
      });
      // Refit after the whole-home history settles. A partial read can fill
      // days, with the completion marker and fit left for a later retry.
      if (result.complete) this.refitFromSettledRecords();
      if (changedDays > 0 || result.complete) this.host.markDirty();
      this.deps.logger.info({
        event: 'weather_meter_backfill_completed',
        deviceId: result.deviceId,
        capability: result.capability,
        ...result.comparison,
        filledFromMeter,
        strippedDays,
        changedDays,
        complete: result.complete,
      });
      if (result.comparison.trackerComparison === 'differs') {
        this.deps.logger.warn({
          event: 'weather_meter_backfill_tracker_mismatch',
          deviceId: result.deviceId,
          capability: result.capability,
          ...result.comparison,
        });
      }
      // Whole-home totals now exist; reconstruct the controlled/uncontrolled
      // split for those historical days from the managed-device meters.
      if (result.complete) this.startControlledKwhBackfill();
    }).catch((error: unknown) => {
      // Marker stays unset, so the next start() retries.
      this.deps.logger.warn({ event: 'weather_meter_backfill_failed', err: normalizeError(error) });
    }).finally(() => {
      this.meterRunning = false;
      // A reload during the (potentially long) fetch superseded this run and
      // its start()-time trigger was blocked by meterRunning — kick the new
      // run now rather than waiting for the next app restart. Gated on
      // supersession so a persistently failing fetch cannot hot-loop.
      if (this.host.isCollectorRunning() && generationAtLaunch !== this.host.currentRunGeneration()) {
        this.startMeterKwhBackfill();
      }
    });
  }

  /**
   * A conclusive absence of meter history still retires legacy Energy-report
   * totals once. The meter completion marker stays unset for a later retry.
   */
  private handleMeterNoSource(
    outcome: Exclude<MeterKwhBackfillOutcome['outcome'], 'resolved' | 'unreadable_history'> | 'flow_source',
  ): void {
    let purgeChangedDays = 0;
    // Tracker-joined fills share the legacy signature once tracker data ages
    // out, so the purge must only run once.
    if (this.host.getState().kwhPurgeVersion !== KWH_PURGE_VERSION) {
      const { state, strippedDays, changedDays } = reconcileKwhSources(this.host.getState(), {
        getDailyKwh: (dateKey) => this.readScopeDailyKwh(dateKey),
        meterDailyKwh: {},
        meterPolicy: 'refresh_and_purge_legacy',
      });
      this.host.setState({ ...state, kwhPurgeVersion: KWH_PURGE_VERSION });
      purgeChangedDays = changedDays;
      this.host.markDirty();
      if (strippedDays > 0) this.deps.logger.info({ event: 'weather_kwh_legacy_purged', strippedDays });
    }
    // Tracker-backed days can still seed the first fit.
    if (purgeChangedDays > 0 || this.host.getState().latestFit === undefined) {
      this.refitFromSettledRecords();
    }
    this.deps.logger.info({ event: 'weather_meter_backfill_no_source', outcome });
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
  startControlledKwhBackfill(): void {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.outdoorDeviceId) return;
    if (this.controlledRunning) return;
    if (!this.host.isMeterScopeResolved()) return;
    const state = this.host.getState();
    if (state.controlledBackfillVersion === CONTROLLED_BACKFILL_VERSION) return;
    if (state.meterKwhBackfillDone !== true) return;
    // The temperature backfill must be SETTLED, not about to re-run: a stale
    // version/device started asynchronously in start() will, on completion,
    // clear the meter+controlled markers and re-chain the meter backfill. Were
    // we to start now (on the still-stale `meterKwhBackfillDone`), this run could
    // race that rebuild and stamp the controlled version against soon-to-be-
    // replaced records — and the post-rebuild meter completion would then skip
    // the controlled chain (version already set). Mirror the meter gate so the
    // controlled split runs only once the chain ahead of it is up to date.
    if (state.backfilledDeviceId !== settings.outdoorDeviceId
      || state.backfillVersion !== TEMP_BACKFILL_VERSION) return;
    this.controlledRunning = true;
    const generationAtLaunch = this.host.currentRunGeneration();
    void resolveControlledDailyKwh({
      readMeterInventory: this.deps.readMeterInventory,
      fetchFromHomeyApi: this.deps.fetchInsights,
      isManaged: this.deps.isManagedDevice,
      getControlledDailyKwh: (dateKey) => this.readScopeDailyKwh(dateKey).controlled,
      meterScopeSinceDateKey: state.meterScopeSinceDateKey,
      timeZone: this.deps.getTimeZone(),
      nowMs: this.deps.getNowMs(),
    }).then((result) => {
      if (!this.host.isCollectorRunning() || generationAtLaunch !== this.host.currentRunGeneration()) return;
      const outcome = applyControlledOutcome({
        state: this.host.getState(),
        result,
        logger: this.deps.logger,
      });
      this.host.setState(outcome.state);
      if (outcome.dirty) this.host.markDirty();
    }).catch((error: unknown) => {
      this.deps.logger.warn({ event: 'weather_controlled_backfill_failed', err: normalizeError(error) });
    }).finally(() => {
      this.controlledRunning = false;
      if (this.host.isCollectorRunning() && generationAtLaunch !== this.host.currentRunGeneration()) {
        this.startControlledKwhBackfill();
      }
    });
  }
}
