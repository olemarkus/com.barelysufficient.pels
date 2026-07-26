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
 *
 * Behaviour is byte-for-byte what the collector did inline: same gates, same
 * markers, same log events, same refit points.
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
import { fetchBackfillDailyRecords, TEMP_BACKFILL_VERSION } from './weatherInsightsBackfill';
import { resolveMeterDailyKwh, type MeterKwhBackfillOutcome } from './meterKwhBackfill';
import { applyControlledOutcome, resolveControlledDailyKwh } from './controlledKwhBackfill';
import type { WeatherCollectorDeps } from './weatherCollectorDeps';

/**
 * The slice of `WeatherCollectorDeps` the chain reads. Enumerated rather than
 * taking the whole bag so the chain has no type-level reach into the
 * persistence port (`store`), the daily-budget write seam
 * (`applySuggestedDailyBudget`), the MET fetch, or the device read.
 * `WeatherCollectorDeps` stays assignable, so the collector passes its own.
 */
export type WeatherBackfillDeps = Pick<
  WeatherCollectorDeps,
  | 'fetchInsights'
  | 'getDailyKwh'
  | 'getNowMs'
  | 'getSettings'
  | 'getTimeZone'
  | 'isManagedDevice'
  | 'logger'
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
  currentRunGeneration: () => number;
};

export class WeatherBackfillChain {
  private temperatureRunning = false;
  private meterRunning = false;
  private controlledRunning = false;

  constructor(private readonly host: WeatherBackfillHost) {}

  private get deps(): WeatherBackfillDeps {
    return this.host.deps;
  }

  /** True while any stage of the chain is in flight; drives the UI "backfilling" state. */
  isRunning(): boolean {
    return this.temperatureRunning || this.meterRunning || this.controlledRunning;
  }

  /**
   * Recompute the energy-signature fit/suggestion from records the caller has
   * established are settled (the kWh layer will not change further), and mark
   * the state for persistence so the refreshed fit survives a restart. Called
   * only from the stages that own the settled-kWh guarantee — never the
   * temperature stage, whose records are still missing historical kWh. A no-op
   * when no recompute dep is wired (so callers need no extra guard).
   */
  private refitFromSettledRecords(): void {
    if (!this.deps.recomputeDerived) return;
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
    void fetchBackfillDailyRecords({
      deviceId,
      fetchInsights: this.deps.fetchInsights,
      getDailyKwh: this.deps.getDailyKwh,
      timeZone: this.deps.getTimeZone(),
      nowMs: this.deps.getNowMs(),
    }).then(({ records, complete }) => {
      // A late completion after stop() must not mutate state the next start()
      // will reload over anyway; the unset marker makes that start re-run it.
      if (!this.host.isCollectorRunning()) return;
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
      // If the device changed mid-run, kick off the new device's backfill now
      // instead of waiting for the next restart/settings write.
      const current = this.deps.getSettings();
      if (
        this.host.isCollectorRunning()
        && current.enabled
        && current.outdoorDeviceId
        && current.outdoorDeviceId !== deviceId
      ) {
        this.startTemperatureBackfill(current);
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
  startMeterKwhBackfill(): void {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.outdoorDeviceId) return;
    if (this.meterRunning) return;
    const state = this.host.getState();
    if (state.meterKwhBackfillDone === true) return;
    // Version included: at an upgrade boot the temperature re-stitch is about
    // to rebuild the records and re-chain this flow — starting now too would
    // run the whole REST sweep twice.
    if (state.backfilledDeviceId !== settings.outdoorDeviceId
      || state.backfillVersion !== TEMP_BACKFILL_VERSION) return;
    this.meterRunning = true;
    const generationAtLaunch = this.host.currentRunGeneration();
    void resolveMeterDailyKwh({
      fetchFromHomeyApi: this.deps.fetchInsights,
      getDailyKwh: this.deps.getDailyKwh,
      timeZone: this.deps.getTimeZone(),
      nowMs: this.deps.getNowMs(),
    }).then((result) => {
      if (!this.host.isCollectorRunning() || generationAtLaunch !== this.host.currentRunGeneration()) return;
      if (result.outcome !== 'resolved') {
        this.handleMeterNoSource(result);
        return;
      }
      const current = this.host.getState();
      const { state: reconciled, filledFromMeter, strippedDays, changedDays } = reconcileKwhSources(current, {
        getDailyKwh: this.deps.getDailyKwh,
        meterDailyKwh: result.dailyKwh,
        // The legacy purge is one-shot AND requires a complete fetch: a
        // partial fetch may fill but never delete (unread windows would read
        // as "unvouched"), and once the stamp lands, values that age beyond
        // every source's reach are kept rather than mistaken for legacy.
        allowStrip: result.complete && current.kwhPurgeVersion !== KWH_PURGE_VERSION,
      });
      this.host.setState({
        ...reconciled,
        ...(result.complete
          ? { meterKwhBackfillDone: true, meterKwhDeviceId: result.deviceId, kwhPurgeVersion: KWH_PURGE_VERSION }
          : {}),
      });
      // Settled-kWh refit point — but ONLY on a complete fetch. A complete meter
      // pass has filled the historical days the temperature stage left kWh-less,
      // so the usable set now spans the year; the controlled split chained below
      // only rewrites the controlled/uncontrolled breakdown (never kwhTotal/temp)
      // so it can't move the fit, making here-before-it correct. An INCOMPLETE
      // resolution (a deep window or competing probe failed) leaves the kWh layer
      // unsettled and the marker unlatched for a next-boot retry — refitting on
      // its partially-filled records is the very transient-fit path this change
      // removes, so defer. The persist below still keeps the partial fills (they
      // are real and additive); only the fit waits. On a complete fetch also seed
      // when nothing changed (a home already wholly tracker-covered, so the meter
      // filled no new days) — else its first fit would wait for the midnight rollup.
      if (result.complete && (changedDays > 0 || this.host.getState().latestFit === undefined)) {
        this.refitFromSettledRecords();
      }
      if (changedDays > 0 || result.complete) this.host.markDirty();
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
   * Even with no successor source, leftovers of the RETIRED unvalidated
   * source must not keep feeding the fit — honest-missing beats
   * silently-wrong. Gated on the election having actually run on evidence:
   * a failed probe means unread data, and unread data must never justify
   * deleting anything. The marker stays unset either way so a later-added
   * meter is adopted.
   */
  private handleMeterNoSource(result: Exclude<MeterKwhBackfillOutcome, { outcome: 'resolved' }>): void {
    const electionConclusive = result.outcome === 'no_candidates' || result.probeFailures === 0;
    let purgeChangedDays = 0;
    // One-shot: tracker-joined backfill kWh is indistinguishable from the
    // legacy class once the tracker's retention passes it, so a recurring
    // strip on no-meter homes would erase legitimate values day by day.
    if (electionConclusive && this.host.getState().kwhPurgeVersion !== KWH_PURGE_VERSION) {
      const { state, strippedDays, changedDays } = reconcileKwhSources(this.host.getState(), {
        getDailyKwh: this.deps.getDailyKwh,
        meterDailyKwh: {},
        allowStrip: true,
      });
      this.host.setState({ ...state, kwhPurgeVersion: KWH_PURGE_VERSION });
      purgeChangedDays = changedDays;
      this.host.markDirty();
      if (strippedDays > 0) this.deps.logger.info({ event: 'weather_kwh_legacy_purged', strippedDays });
    }
    // Single terminal refit for the no-meter path: when the purge moved the
    // usable set, OR to seed the very first fit for a genuinely no-meter home
    // whose only kWh is the tracker-joined recent days the temperature stage
    // upserted (which no longer refits on its half-filled records) — else that
    // home would sit on `learning` until the next midnight rollup. ONE call, so
    // a purge that lands below MIN_USABLE_DAYS (fit still null) can't re-trigger
    // a second refit + duplicate `weather_advisor_fit` line. Gated on a
    // CONCLUSIVE election: an inconclusive one (a probe transiently failed)
    // leaves the marker unset so the next boot retries the meter — the kWh layer
    // may still fill, so defer rather than seed a thin fit. A steady-state reboot
    // already carries a fit and skips the O(n²) refit; later days arrive via
    // rollup.
    if (electionConclusive && (purgeChangedDays > 0 || this.host.getState().latestFit === undefined)) {
      this.refitFromSettledRecords();
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
  startControlledKwhBackfill(): void {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.outdoorDeviceId) return;
    if (this.controlledRunning) return;
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
      fetchFromHomeyApi: this.deps.fetchInsights,
      isManaged: this.deps.isManagedDevice,
      getControlledDailyKwh: (dateKey) => this.deps.getDailyKwh(dateKey).controlled,
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
