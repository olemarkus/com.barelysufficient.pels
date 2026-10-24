import type { PowerSource } from '../lib/power/powerSource';
import type { PowerSampleAdmission } from '../lib/app/appContext';
import type { DeviceTransportPort } from '../lib/device/deviceTransport';
import type { DeviceSurfaces } from '../packages/contracts/src/deviceSurfaces';
import type { PlanInputSnapshotDevice } from '../lib/planInput/runtimeDeviceRead';
import type { MainMeterRead, MeterPowerSample as HomePowerSample } from '../lib/ports/homeMeterReadings';
import { getDebugEmitter, type Logger as PinoLogger } from '../lib/logging/logger';
import type { PlanEngine } from '../lib/plan/planEngine';
import type { PlanService } from '../lib/plan/planService';
import { withHeadroomCurrentOn } from '../lib/plan/planHeadroomSupport';
import type { MainMeterSelection } from '../packages/contracts/src/mainMeterSelection';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import type { PlanRebuildTrigger } from '../lib/plan/planRebuildTrigger';
import {
  TargetPowerProbeScheduler,
  type DueTargetPowerProbe,
} from '../lib/device/targetPowerProbeScheduler';
import { SnapshotRefreshScheduler, type SnapshotRefreshOptions } from '../lib/device/snapshotRefreshScheduler';

export { createTargetPowerReachabilityAppWiring } from './appTargetPowerReachabilityWiring';

const sameMainMeterSelection = (
  left: MainMeterSelection,
  right: MainMeterSelection,
): boolean => (
  left.state === right.state
  && (
    left.state !== 'resolved'
    || (right.state === 'resolved' && left.meterDeviceId === right.meterDeviceId)
  )
);

export class AppSnapshotHelpers {
  private readonly targetPowerProbeScheduler: TargetPowerProbeScheduler;
  private readonly refreshScheduler: SnapshotRefreshScheduler;

  constructor(private readonly deps: {
    getPowerSource: () => PowerSource;
    timers: TimerRegistry;
    getDeviceManager: () => DeviceTransportPort | undefined;
    getPlanEngine: () => PlanEngine | undefined;
    getPlanService: () => PlanService | undefined;
    getPlanInputSnapshot: () => PlanInputSnapshotDevice[];
    resolveManagedState: (deviceId: string) => boolean;
    isCapacityControlEnabled: (deviceId: string) => boolean;
    getStructuredLogger: (component: string) => PinoLogger;
    getNow: () => Date;
    logPeriodicStatus: (options?: { includeDeviceHealth?: boolean }) => void;
    persistFilledModeTargets: () => void;
    getFlowReportedDeviceIds: () => string[];
    emitFlowBackedRefreshRequests: (deviceIds: string[]) => Promise<void>;
    emitSettingsUiDevicesUpdated: () => void;
    recordPowerSample: (sample: HomePowerSample) => Promise<PowerSampleAdmission>;
    /** Main's part of the refresh's meter read for a selection (`resolveMainMeterRead`, `lib/home`). */
    readMainMeter: (selection: MainMeterSelection) => MainMeterRead;
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
    reconcileTargetPowerReachability?: (snapshot: DeviceSurfaces[], nowMs: number) => void;
    /**
     * The joined surface, UNDECORATED. The reachability pass reads the observed
     * `reportedStepId` as well as the descriptor's target-power config, so a
     * descriptor read is not enough — and the decorated getter is not wanted
     * either: decoration resolves the ladder from the very reachability state
     * this pass is about to update, so taking it before would price the pass
     * against a state one step stale.
     */
    getDeviceSurfaces: () => DeviceSurfaces[];
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
    this.refreshScheduler = new SnapshotRefreshScheduler(
      deps.timers,
      deps.getNow,
      deps.getDeviceManager,
      (deviceManager, options) => this.runSnapshotRefreshCycle(deviceManager, options),
      deps.logPeriodicStatus,
      (thresholdMs) => deps.getPlanEngine()?.hasPendingTargetCommandsOlderThan(thresholdMs) === true,
    );
  }

  /** Whether a post-actuation refresh is already armed. */
  hasPendingPostActuationRefresh(): boolean {
    return this.refreshScheduler.hasPendingPostActuationRefresh();
  }

  startPeriodicSnapshotRefresh(): void {
    this.refreshScheduler.start();
    this.targetPowerProbeScheduler.start();
  }

  stop(): void {
    this.refreshScheduler.stop();
    this.targetPowerProbeScheduler.stop();
  }

  async refreshTargetDevicesSnapshot(
    options: SnapshotRefreshOptions = {},
  ): Promise<void> {
    await this.refreshScheduler.refresh(options);
  }

  schedulePostActuationRefresh(): void {
    this.refreshScheduler.schedulePostActuationRefresh();
  }

  scheduleTargetPowerProbeSettlement(dueAtMs: number): void {
    this.targetPowerProbeScheduler.scheduleSettlement(dueAtMs);
  }

  scheduleTargetPowerProbe(): void {
    this.targetPowerProbeScheduler.scheduleProbe();
  }

  private async runSnapshotRefreshCycle(
    deviceManager: DeviceTransportPort,
    options: SnapshotRefreshOptions,
  ): Promise<void> {
    if (options.emitFlowBackedRefresh !== false) {
      await this.deps.emitFlowBackedRefreshRequests(this.deps.getFlowReportedDeviceIds());
    }
    getDebugEmitter('snapshot', 'devices')({
      event: 'target_snapshot_refresh_started',
    });
    const meterSelectionAtStart = this.deps.resolveMainMeterSelection();
    const mainMeterRead = this.deps.readMainMeter(meterSelectionAtStart);
    const meterReadings = await deviceManager.refreshSnapshot({
      includeLivePower: options.fast !== true,
      targetedRefresh: options.targeted,
      // Bind the same semantic selection used by the end-of-cycle staleness
      // fence into the actual fetch. The adapter may recover or fail again
      // while this async refresh is in flight; an independent second read
      // would otherwise let a sample for another authority slip through.
      meterDeviceIds: mainMeterRead.meterDeviceIds,
    });

    this.deps.reconcileTargetPowerReachability?.(
      this.deps.getDeviceSurfaces(),
      this.deps.getNow().getTime(),
    );
    this.scheduleTargetPowerProbe();

    const snapshot = this.deps.getPlanInputSnapshot();
    this.deps.persistFilledModeTargets();
    const enforcedSnapshot = snapshot.map((device) => {
      // Enforced FIRST, then stamped: `withHeadroomCurrentOn` resolves its
      // answer from the device's parse-time `controllable`, and the whole point
      // of the two stamps below is that the parse-time value can be stale. Doing
      // it the other way round hands the plan layer a fresh `controllable`
      // alongside an authority resolved from the stale one — two answers to one
      // question in a single object.
      const controllable = this.deps.isCapacityControlEnabled(device.id);
      return {
        // `withHeadroomCurrentOn` stamps the on/off truth the headroom/activation
        // path now reads (a raw snapshot carries no `currentOn`).
        ...withHeadroomCurrentOn({ ...device, controllable }),
        managed: this.deps.resolveManagedState(device.id),
        controllable,
      };
    });
    await this.deps.getPlanService()?.syncLivePlanState('snapshot_refresh');
    this.deps.getPlanService()?.syncHeadroomCardState(enforcedSnapshot);
    getDebugEmitter('devices', 'devices')({
      event: 'target_devices_refreshed',
      reasonCode: options.targeted === true ? 'targeted_refresh' : 'snapshot_refresh',
      deviceCount: snapshot.length,
      targetedRefresh: options.targeted === true,
    });
    this.deps.emitSettingsUiDevicesUpdated();
    const homePowerSample = meterReadings ? mainMeterRead.sampleFrom(meterReadings) : null;
    await this.recordImplicitHomeyEnergySample(options, homePowerSample, meterSelectionAtStart);
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
    options: SnapshotRefreshOptions,
    meterSelectionAtStart: MainMeterSelection,
  ): 'admitted' | 'not_requested' | 'not_homey_energy' | 'selection_unavailable' | 'stale_meter' {
    if (options.recordHomeyEnergySample === false) return 'not_requested';
    if (this.deps.getPowerSource() !== 'homey_energy') return 'not_homey_energy';
    // An unavailable start selection produces NO recordable sample: the fetch
    // still fills the per-device lanes but requests no Main meter
    // (`readMainMeter`), so the
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
    options: SnapshotRefreshOptions,
    sample: HomePowerSample | null, meterSelectionAtStart: MainMeterSelection,
  ): Promise<void> {
    const admission = this.classifyImplicitHomeyEnergySample(options, meterSelectionAtStart);
    if (admission === 'stale_meter') {
      // The whole-home meter selection changed while this refresh cycle was in
      // flight — the sample was read for the previous selection, so recording
      // it now would overwrite the new meter's fresh samples with stale watts.
      getDebugEmitter('snapshot', 'devices')({
        event: 'implicit_homey_energy_sample_discarded_stale_meter',
      });
    }
    if (admission !== 'admitted') return;

    if (sample) {
      await this.deps.recordPowerSample(sample);
    }
  }
}
