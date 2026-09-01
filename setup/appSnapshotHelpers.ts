import type { PowerSource } from '../lib/power/powerSource';
import type { PowerSampleAdmission } from '../lib/app/appContext';
import type { DeviceTransport } from '../lib/device/deviceTransport';
import type { HomePowerSampleWithIdentity as HomePowerSample } from '../lib/device/transport/resolvedHomeMeterDispatch';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../lib/logging/logger';
import type { PlanEngine } from '../lib/plan/planEngine';
import { TARGET_CONFIRMATION_STUCK_POLL_MS } from '../lib/plan/planConstants';
import type { PlanService } from '../lib/plan/planService';
import { withHeadroomCurrentOn } from '../lib/plan/planHeadroomSupport';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { MainMeterSelection } from '../packages/contracts/src/mainMeterSelection';
import { normalizeError } from '../lib/utils/errorUtils';
import { runWithoutContext } from '../lib/logging/alsContext';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import type { ResolveOperatingModeForDevice } from './appDeviceSupport';
import type { PlanRebuildTrigger } from '../lib/plan/planRebuildTrigger';
import {
  TargetPowerProbeScheduler,
  type DueTargetPowerProbe,
} from '../lib/device/targetPowerProbeScheduler';

export { createTargetPowerReachabilityAppWiring } from './appTargetPowerReachabilityWiring';

const PERIODIC_STATUS_MINUTE_INTERVALS = [25, 55];
const TARGET_CONFIRMATION_POLL_INTERVAL_MS = TARGET_CONFIRMATION_STUCK_POLL_MS;
const POST_ACTUATION_REFRESH_DELAY_MS = 5_000;
// The app's device poll. A Homey driver pushes a capability only on value
// CHANGE, so a device that keeps doing the same thing sends nothing — and the
// EV car-link probe's correlation pass runs over the FETCHED device list
// (`observeEvCarLinkAndResubscribe`), which is also where a class-`car` device,
// dropped at parse, becomes visible at all. Something has to ask.
//
// This is a poll, not a verdict about any device. It used to be gated on a
// 40-minute per-device "stale observation" window, which meant the app polled
// whenever some device happened to have been quiet for a while — an arbitrary
// trigger dressed up as a health signal, and one that produced a
// `stale_device_observation_refresh` log line per window per device for the
// entire uptime. In production that gate was open continuously, so the app in
// fact fetched every managed device roughly once a minute. The gate is gone and
// the cadence is now stated outright, at the slowest value nothing needs faster
// than: the tightest consumer is the EV car-link probe (a car's `measure_battery`
// only reaches PELS on a fetch), and a charging session tolerates 5 minutes.
//
// This is the app's ONLY device fetch loop. The `:25`/`:55` timer below used to
// fetch too; it now only writes the periodic status log, because a second
// fetcher on a coarser schedule adds nothing a 5-minute poll has not already
// done.
const DEVICE_POLL_INTERVAL_MS = 5 * 60 * 1000;

const sameMainMeterSelection = (
  left: MainMeterSelection,
  right: MainMeterSelection,
): boolean => (
  left.state === right.state
  && (
    left.state === 'unavailable'
    || (right.state === 'resolved' && left.meterDeviceId === right.meterDeviceId)
  )
);

export type RefreshTargetDevicesSnapshotOptions = {
  fast?: boolean;
  targeted?: boolean;
  recordHomeyEnergySample?: boolean;
  emitFlowBackedRefresh?: boolean;
};

export class AppSnapshotHelpers {
  private snapshotRefreshStopped = true;
  private isSnapshotRefreshing = false;
  private snapshotRefreshPending = false;
  // Promise for the currently-running snapshot refresh cycle. Concurrent
  // callers await this promise so they see the post-refresh in-memory
  // snapshot instead of returning while the refresh is still in flight.
  // Cleared inside the same `finally` that flips `isSnapshotRefreshing` back
  // to false so awaiters never observe a resolved-but-still-running state.
  // Synchronous re-entry (before the outer call has yielded once) leaves
  // this `null`; nested callers in that window keep the legacy fire-and-
  // forget queue-and-return behavior to avoid awaiting their own caller.
  private snapshotRefreshInFlight: Promise<void> | null = null;
  private readonly targetPowerProbeScheduler: TargetPowerProbeScheduler;

  constructor(private readonly deps: {
    getPowerSource: () => PowerSource;
    timers: TimerRegistry;
    getDeviceManager: () => DeviceTransport | undefined;
    getPlanEngine: () => PlanEngine | undefined;
    getPlanService: () => PlanService | undefined;
    getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
    resolveManagedState: (deviceId: string) => boolean;
    isCapacityControlEnabled: (deviceId: string) => boolean;
    getStructuredLogger: (component: string) => PinoLogger | undefined;
    getStructuredDebugEmitter: (component: string, topic: 'devices' | 'plan') => StructuredDebugEmitter;
    getNow: () => Date;
    logPeriodicStatus: (options?: { includeDeviceHealth?: boolean }) => void;
    disableUnsupportedDevices: (
      snapshot: TargetDeviceSnapshot[],
      resolveOperatingModeForDevice?: ResolveOperatingModeForDevice,
    ) => void;
    persistFilledModeTargets: (snapshot: TargetDeviceSnapshot[]) => void;
    getFlowReportedDeviceIds: () => string[];
    emitFlowBackedRefreshRequests: (deviceIds: string[]) => Promise<void>;
    emitSettingsUiDevicesUpdated: () => void;
    recordPowerSample: (sample: HomePowerSample) => Promise<PowerSampleAdmission>;
    // The explicit whole-home meter selection, resolved fresh per call by the
    // settings adapter that owns the SDK provenance. Required, because there is
    // no honest default: `resolved/null` would mean Automatic, silently
    // promoting an unread selection to the one answer `readMainMeterSelection`
    // exists to never assume. It both directs the fetch and fences the implicit
    // homey_energy sample — a refresh cycle reads its live report near the start
    // and records the sample at the end, so a meter change mid-cycle would
    // otherwise record the OLD meter's watts seconds after the user switched
    // (the poll path has the same fence via its pollGeneration counter).
    resolveMainMeterSelection: () => MainMeterSelection;
    reconcileTargetPowerReachability?: (snapshot: TargetDeviceSnapshot[], nowMs: number) => void;
    getNextTargetPowerProbe?: () => DueTargetPowerProbe | undefined;
    hasPendingTargetPowerProbe?: () => boolean;
    rebuildOwningHomePlanForDevice?: (deviceId: string, trigger: PlanRebuildTrigger) => Promise<unknown>;
  }) {
    this.targetPowerProbeScheduler = new TargetPowerProbeScheduler({
      timers: deps.timers,
      getNowMs: () => deps.getNow().getTime(),
      getNextProbe: () => deps.getNextTargetPowerProbe?.(),
      hasPendingProbe: () => deps.hasPendingTargetPowerProbe?.() === true,
      rebuildForDueProbe: async (deviceId) => {
        await deps.rebuildOwningHomePlanForDevice?.(deviceId, 'target_power_probe_due');
      },
      refreshForSettlement: async () => this.refreshTargetDevicesSnapshot({ targeted: true }),
      getLogger: () => deps.getStructuredLogger('snapshot'),
    });
  }

  /**
   * Whether a post-actuation refresh is already armed. The timer registry owns
   * the handle, and "is one pending?" is the only question any caller ever asked
   * of it — so it answers that, rather than handing out a handle for a caller to
   * null-check.
   */
  hasPendingPostActuationRefresh(): boolean {
    return this.deps.timers.has('postActuationRefresh');
  }

  startPeriodicSnapshotRefresh(): void {
    this.snapshotRefreshStopped = false;
    this.targetPowerProbeScheduler.start();
    this.schedulePeriodicStatusLog();
    this.scheduleNextDevicePoll();

    this.deps.timers.registerInterval(
      'targetConfirmationPoll',
      setInterval(() => {
        this.pollStuckTargetConfirmations()
          .catch((error) => this.deps.getStructuredLogger('snapshot')?.error({
            event: 'stuck_target_confirmation_poll_failed',
            err: normalizeError(error),
          }));
      }, TARGET_CONFIRMATION_POLL_INTERVAL_MS),
    );
  }

  stop(): void {
    this.snapshotRefreshStopped = true;
    this.targetPowerProbeScheduler.stop();
    this.snapshotRefreshPending = false;
    this.deps.timers.clear('periodicStatus');
    this.deps.timers.clear('devicePoll');
    this.deps.timers.clear('targetConfirmationPoll');
    this.deps.timers.clear('postActuationRefresh');
  }

  async refreshTargetDevicesSnapshot(
    options: RefreshTargetDevicesSnapshotOptions = {},
  ): Promise<void> {
    const deviceManager = this.deps.getDeviceManager();
    if (!deviceManager) return;

    if (this.isSnapshotRefreshing) {
      this.snapshotRefreshPending = true;
      if (this.snapshotRefreshInFlight) {
        // Overlapping caller arrived after the outer call yielded once and
        // assigned the loop promise — await it so callers (e.g.
        // `/ui_refresh_devices`) see the post-refresh in-memory snapshot
        // instead of returning while the refresh is still running. (TODO 728.)
        this.deps.getStructuredDebugEmitter('snapshot', 'devices')({
          event: 'snapshot_refresh_coalesced',
          mode: 'awaiting_in_flight',
        });
        await this.snapshotRefreshInFlight;
        return;
      }
      // Synchronous re-entry window (the outer call has not yielded yet, so
      // the loop promise is not visible). Keep the legacy queue-and-return
      // behavior to avoid awaiting a promise the caller is itself producing.
      this.deps.getStructuredDebugEmitter('snapshot', 'devices')({
        event: 'snapshot_refresh_coalesced',
        mode: 'queued',
      });
      return;
    }

    this.isSnapshotRefreshing = true;
    const refreshPromise = this.runSnapshotRefreshLoop(deviceManager, options);
    this.snapshotRefreshInFlight = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      this.isSnapshotRefreshing = false;
      this.snapshotRefreshPending = false;
      this.snapshotRefreshInFlight = null;
    }
  }

  private async runSnapshotRefreshLoop(
    deviceManager: DeviceTransport,
    options: RefreshTargetDevicesSnapshotOptions,
  ): Promise<void> {
    let shouldEmitFlowBackedRefresh = options.emitFlowBackedRefresh !== false;
    do {
      this.snapshotRefreshPending = false;
      await this.runSnapshotRefreshCycle(deviceManager, {
        ...options,
        emitFlowBackedRefresh: shouldEmitFlowBackedRefresh,
      });
      shouldEmitFlowBackedRefresh = false;
    } while (this.snapshotRefreshPending && !this.snapshotRefreshStopped);
  }

  /**
   * Self-rescheduling rather than an interval so a slow refresh cannot stack
   * polls on top of itself. `refreshTargetDevicesSnapshot` already coalesces a
   * concurrent caller, but not queueing in the first place is cheaper.
   *
   * The registry owns the handle: `registerTimeout` clears any timer already
   * under this key, so re-arming needs no local copy to check first.
   */
  private scheduleNextDevicePoll(): void {
    if (this.snapshotRefreshStopped) return;
    this.deps.timers.registerTimeout(
      'devicePoll',
      setTimeout(async () => {
        this.deps.timers.clear('devicePoll');
        try {
          await this.refreshTargetDevicesSnapshot({ targeted: true });
        } catch (error) {
          this.deps.getStructuredLogger('snapshot')?.error({
            event: 'device_poll_failed',
            err: normalizeError(error),
          });
        } finally {
          this.scheduleNextDevicePoll();
        }
      }, DEVICE_POLL_INTERVAL_MS),
    );
  }

  /**
   * The twice-hourly status log. It used to fetch every device first and report
   * device health only if that fetch succeeded; the device poll owns fetching
   * now, so this reports on the committed snapshot — which is the device health,
   * never more than `DEVICE_POLL_INTERVAL_MS` old.
   */
  schedulePeriodicStatusLog(): void {
    const now = this.deps.getNow();
    const currentMinute = now.getMinutes();
    const nextMinute = PERIODIC_STATUS_MINUTE_INTERVALS.find((minute) => minute > currentMinute);

    const next = new Date(now);
    if (nextMinute !== undefined) {
      next.setMinutes(nextMinute, 0, 0);
    } else {
      next.setHours(now.getHours() + 1, PERIODIC_STATUS_MINUTE_INTERVALS[0], 0, 0);
    }

    this.deps.timers.registerTimeout('periodicStatus', setTimeout(() => {
      this.deps.timers.clear('periodicStatus');
      try {
        this.deps.logPeriodicStatus({ includeDeviceHealth: true });
      } finally {
        if (!this.snapshotRefreshStopped) this.schedulePeriodicStatusLog();
      }
    }, next.getTime() - now.getTime()));
  }

  async pollStuckTargetConfirmations(): Promise<void> {
    if (!this.deps.getPlanEngine()?.hasPendingTargetCommandsOlderThan(TARGET_CONFIRMATION_STUCK_POLL_MS)) {
      return;
    }

    this.deps.getStructuredDebugEmitter('snapshot', 'devices')({
      event: 'stuck_target_confirmation_poll',
      thresholdMs: TARGET_CONFIRMATION_STUCK_POLL_MS,
    });
    await this.refreshTargetDevicesSnapshot({ targeted: true });
  }

  schedulePostActuationRefresh(): void {
    if (this.deps.timers.has('postActuationRefresh')) {
      this.deps.getStructuredDebugEmitter('snapshot', 'plan')({
        event: 'post_actuation_refresh_skipped',
        reason: 'already_scheduled',
      });
      return;
    }

    this.deps.getStructuredDebugEmitter('snapshot', 'plan')({
      event: 'post_actuation_refresh_scheduled',
      delayMs: POST_ACTUATION_REFRESH_DELAY_MS,
    });
    runWithoutContext(() => (
      this.deps.timers.registerTimeout('postActuationRefresh', setTimeout(async () => {
        this.deps.timers.clear('postActuationRefresh');
        this.deps.getStructuredDebugEmitter('snapshot', 'plan')({
          event: 'post_actuation_refresh_running',
        });
        try {
          await this.refreshTargetDevicesSnapshot({ targeted: true, recordHomeyEnergySample: false });
        } catch (error) {
          this.deps.getStructuredLogger('snapshot')?.error({
            event: 'post_actuation_snapshot_refresh_failed',
            err: normalizeError(error),
          });
        }
      }, POST_ACTUATION_REFRESH_DELAY_MS))
    ));
  }

  scheduleTargetPowerProbeSettlement(dueAtMs: number): void {
    this.targetPowerProbeScheduler.scheduleSettlement(dueAtMs);
  }

  scheduleTargetPowerProbe(): void {
    this.targetPowerProbeScheduler.scheduleProbe();
  }

  private async runSnapshotRefreshCycle(
    deviceManager: DeviceTransport,
    options: RefreshTargetDevicesSnapshotOptions,
  ): Promise<void> {
    if (options.emitFlowBackedRefresh !== false) {
      await this.deps.emitFlowBackedRefreshRequests(this.deps.getFlowReportedDeviceIds());
    }
    this.deps.getStructuredDebugEmitter('snapshot', 'devices')({
      event: 'target_snapshot_refresh_started',
    });
    const meterSelectionAtStart = this.deps.resolveMainMeterSelection();
    const homePowerSample = await deviceManager.refreshSnapshot({
      includeLivePower: options.fast !== true,
      targetedRefresh: options.targeted,
      // Bind the same semantic selection used by the end-of-cycle staleness
      // fence into the actual fetch. The adapter may recover or fail again
      // while this async refresh is in flight; an independent second read
      // would otherwise let a sample for another authority slip through.
      mainMeterSelection: meterSelectionAtStart,
    });

    this.deps.reconcileTargetPowerReachability?.(
      deviceManager.getSnapshot(),
      this.deps.getNow().getTime(),
    );
    this.scheduleTargetPowerProbe();

    const snapshot = this.deps.getLatestTargetSnapshot();
    this.deps.disableUnsupportedDevices(snapshot);
    this.deps.persistFilledModeTargets(snapshot);
    const enforcedSnapshot = snapshot.map((device) => ({
      // `withHeadroomCurrentOn` stamps the on/off truth the headroom/activation
      // path now reads (a raw snapshot carries no `currentOn`).
      ...withHeadroomCurrentOn(device),
      managed: this.deps.resolveManagedState(device.id),
      controllable: this.deps.isCapacityControlEnabled(device.id),
    }));
    await this.deps.getPlanService()?.syncLivePlanState('snapshot_refresh');
    this.deps.getPlanService()?.syncHeadroomCardState({
      devices: enforcedSnapshot,
      cleanupMissingDevices: true,
      reconciliationContext: 'snapshot_refresh',
    });
    this.deps.getStructuredLogger('devices')?.debug({
      event: 'target_devices_refreshed',
      reasonCode: options.targeted === true ? 'targeted_refresh' : 'snapshot_refresh',
      deviceCount: snapshot.length,
      targetedRefresh: options.targeted === true,
    });
    this.deps.emitSettingsUiDevicesUpdated();
    await this.recordImplicitHomeyEnergySample(deviceManager, options, homePowerSample, meterSelectionAtStart);
  }

  /**
   * Retry only the support/default classification that may have been deferred
   * when the snapshot arrived before ownership. The existing snapshot is
   * enough; ownership readiness cannot make the Homey device payload fresher.
   */
  public retryDeferredOvershootSeed(
    resolveOperatingModeForDevice: ResolveOperatingModeForDevice,
  ): void {
    this.deps.disableUnsupportedDevices(
      this.deps.getLatestTargetSnapshot(),
      resolveOperatingModeForDevice,
    );
  }

  /**
   * Will this cycle's live-power read become the sample the power tracker
   * serves? Evaluated ONCE, at record time, and the answer gates the sample
   * AND the meter identity riding on it as one object: an unadmitted sample
   * never reaches `recordPowerSample`, so the pipeline never publishes its
   * identity — there is no second decision to diverge from this one. (The
   * post-actuation refresh — scheduled through these shared helpers by ANY
   * home's actuation, including a meter area's — is exactly the caller this
   * protects against: it reads live power and discards the sample, and must
   * not republish Main's meter while the tracker still holds the area's watts.)
   *
   * Deliberately NOT total: `getPowerSource()` throws on a suspect settings
   * read, and that has always surfaced as a failed refresh.
   */
  private classifyImplicitHomeyEnergySample(
    options: RefreshTargetDevicesSnapshotOptions,
    meterSelectionAtStart: MainMeterSelection,
  ): 'admitted' | 'not_requested' | 'not_homey_energy' | 'selection_unavailable' | 'stale_meter' {
    if (options.recordHomeyEnergySample === false) return 'not_requested';
    if (this.deps.getPowerSource() !== 'homey_energy') return 'not_homey_energy';
    // An unavailable start selection produces NO recordable sample: the fetch
    // falls back to Automatic for the per-device lanes but discards the
    // whole-home value (`fetchLivePowerReport` nulls `homePowerW`), so the
    // `if (sample)` guard below never records regardless of this answer. The
    // arm exists for classification honesty: without it, a selection that
    // recovers mid-flight would classify `stale_meter` and emit a mislabelled
    // `implicit_homey_energy_sample_discarded_stale_meter` event for a cycle
    // that never had a recordable sample to discard.
    if (meterSelectionAtStart.state !== 'resolved') return 'selection_unavailable';
    return sameMainMeterSelection(this.deps.resolveMainMeterSelection(), meterSelectionAtStart)
      ? 'admitted'
      : 'stale_meter';
  }

  private async recordImplicitHomeyEnergySample(
    deviceManager: DeviceTransport, options: RefreshTargetDevicesSnapshotOptions,
    sample: HomePowerSample | null, meterSelectionAtStart: MainMeterSelection,
  ): Promise<void> {
    const admission = this.classifyImplicitHomeyEnergySample(options, meterSelectionAtStart);
    if (admission === 'stale_meter') {
      // The whole-home meter selection changed while this refresh cycle was in
      // flight — the sample was read for the previous selection, so recording
      // it now would overwrite the new meter's fresh samples with stale watts.
      this.deps.getStructuredDebugEmitter('snapshot', 'devices')({
        event: 'implicit_homey_energy_sample_discarded_stale_meter',
      });
    }
    if (admission !== 'admitted') return;

    if (sample) {
      const pipelineAdmission = await this.deps.recordPowerSample(sample);
      deviceManager.noteAdmittedAutomaticHomeMeter(
        pipelineAdmission.state === 'admitted'
          && meterSelectionAtStart.state === 'resolved' && meterSelectionAtStart.meterDeviceId === null
          ? sample.resolvedHomeMeterDeviceId : null,
      );
    }
  }
}
