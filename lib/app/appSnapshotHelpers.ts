import type { HomeyRuntime } from '../ports/homeyRuntime';
import type { DeviceTransport } from '../device/deviceTransport';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import type { PlanEngine } from '../plan/planEngine';
import { TARGET_CONFIRMATION_STUCK_POLL_MS } from '../plan/planConstants';
import {
  getLatestDeviceObservationMs,
  isDeviceObservationStale,
  isDeviceObservationStaleByAge,
} from '../observer/observationFreshness';
import type { PlanService } from '../plan/planService';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { normalizeError } from '../utils/errorUtils';
import type { TimerRegistry } from './timerRegistry';

const SNAPSHOT_REFRESH_MINUTE_INTERVALS = [25, 55];
const TARGET_CONFIRMATION_POLL_INTERVAL_MS = TARGET_CONFIRMATION_STUCK_POLL_MS;
const STALE_OBSERVATION_FALLBACK_REFRESH_INTERVAL_MS = 60 * 1000;
const POST_ACTUATION_REFRESH_DELAY_MS = 5_000;
// Per-device backoff for the `stale_device_observation_refresh` info log.
// The refresh loop itself still runs every minute (drivers that only republish
// per-capability `lastUpdated` on value change look "stale" indefinitely even
// when healthy), but we only emit one structured log per device per window.
// Matches the 15-minute window used by other repeat-event throttles in the
// planner. In-memory only per `feedback_homey_sdk_unreliable`: on restart the
// first cycle re-emits as expected.
const STALE_OBSERVATION_REFRESH_LOG_BACKOFF_MS = 15 * 60 * 1000;

export type RefreshTargetDevicesSnapshotOptions = {
  fast?: boolean;
  targeted?: boolean;
  recordHomeyEnergySample?: boolean;
  emitFlowBackedRefresh?: boolean;
};

export class AppSnapshotHelpers {
  private snapshotRefreshTimer?: ReturnType<typeof setTimeout>;
  private staleObservationRefreshTimer?: ReturnType<typeof setTimeout>;
  private staleObservationRefreshStopped = true;
  private targetConfirmationPollInterval?: ReturnType<typeof setInterval>;
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
  private postActuationRefreshTimer?: ReturnType<typeof setTimeout>;
  private deviceObservationStaleById = new Map<string, boolean>();
  // Last `stale_device_observation_refresh` log emit per device. We suppress
  // repeat emits within `STALE_OBSERVATION_REFRESH_LOG_BACKOFF_MS` so that a
  // device whose driver only republishes `lastUpdated` on value change does
  // not produce one log line per 60s cycle for the entire app uptime. Cleared
  // per device when that device becomes fresh again, so a returning device
  // re-emits the next time it stalls. Per-device map (not global) so 10 stale
  // devices still produce 10 distinct log streams.
  private staleRefreshLogLastEmitMsById = new Map<string, number>();

  constructor(private readonly deps: {
    homey: HomeyRuntime;
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
    disableUnsupportedDevices: (snapshot: TargetDeviceSnapshot[]) => void;
    seedMissingModeTargets: (snapshot: TargetDeviceSnapshot[]) => void;
    getFlowReportedDeviceIds: () => string[];
    emitFlowBackedRefreshRequests: (deviceIds: string[]) => Promise<void>;
    emitSettingsUiDevicesUpdated: () => void;
    recordPowerSample: (powerW: number) => Promise<void>;
    /**
     * Reads the observer-owned whole-home power scalar (PR2a of the
     * observer/transport split). The value originates from a Homey SDK energy
     * report in the device layer; transport pushes it to the observer's holder
     * and this reads it back. Wiring (`lib/app/`) → observer is an allowed edge.
     */
    getHomePowerW: () => number | null;
  }) {}

  getPostActuationRefreshTimer(): ReturnType<typeof setTimeout> | undefined {
    return this.postActuationRefreshTimer;
  }

  startPeriodicSnapshotRefresh(): void {
    if (this.snapshotRefreshTimer) {
      this.deps.timers.clear('snapshotRefresh');
      this.snapshotRefreshTimer = undefined;
    }
    this.scheduleNextSnapshotRefresh();
    this.startStaleObservationRefreshFallback();

    if (this.targetConfirmationPollInterval) {
      this.deps.timers.clear('targetConfirmationPoll');
      this.targetConfirmationPollInterval = undefined;
    }
    this.targetConfirmationPollInterval = this.deps.timers.registerInterval(
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
    this.staleObservationRefreshStopped = true;
    this.snapshotRefreshPending = false;
    if (this.snapshotRefreshTimer) {
      this.deps.timers.clear('snapshotRefresh');
      this.snapshotRefreshTimer = undefined;
    }
    if (this.staleObservationRefreshTimer) {
      this.deps.timers.clear('staleObservationRefresh');
      this.staleObservationRefreshTimer = undefined;
    }
    if (this.targetConfirmationPollInterval) {
      this.deps.timers.clear('targetConfirmationPoll');
      this.targetConfirmationPollInterval = undefined;
    }
    if (this.postActuationRefreshTimer) {
      this.deps.timers.clear('postActuationRefresh');
      this.postActuationRefreshTimer = undefined;
    }
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
    } while (this.snapshotRefreshPending && !this.staleObservationRefreshStopped);
  }

  async refreshStaleDeviceObservations(): Promise<void> {
    if (!this.deps.getDeviceManager() || this.isSnapshotRefreshing) return;

    const nowMs = this.deps.getNow().getTime();
    const snapshot = this.deps.getLatestTargetSnapshot().filter((device) => this.deps.resolveManagedState(device.id));
    this.logDeviceFreshnessTransitions(snapshot, 'stale_observation_check', nowMs);
    // `isDeviceObservationStaleByAge` excludes `'unknown'` (never-observed)
    // devices on purpose — re-fetching them cannot change `unknown` into
    // `fresh`, so the refresh loop never runs for them and the log backoff
    // below is moot. The `unknown` case is handled at the predicate boundary,
    // not here.
    const staleDevices = snapshot.filter((device) => isDeviceObservationStaleByAge(device, nowMs));
    // Always prune backoff entries for devices that are no longer stale (fresh
    // again, removed, or never-observed) so a device that returns to fresh and
    // later stalls again will emit a new log on its next still-stale cycle.
    this.pruneStaleRefreshLogBackoff(snapshot, nowMs);
    if (staleDevices.length === 0) return;

    this.deps.getStructuredDebugEmitter('snapshot', 'devices')({
      event: 'stale_observation_refresh_triggered',
      staleDevices: staleDevices.length,
      managedDevices: snapshot.length,
    });
    const staleDeviceIds = new Set(staleDevices.map((device) => device.id));
    await this.refreshTargetDevicesSnapshot({ targeted: true });

    const refreshedSnapshot = this.deps
      .getLatestTargetSnapshot()
      .filter((device) => this.deps.resolveManagedState(device.id));
    const refreshedById = new Map(refreshedSnapshot.map((device) => [device.id, device]));
    let freshAfterRefreshDevices = 0;
    let stillStaleAfterRefreshDevices = 0;
    const stillStaleDeviceIds: string[] = [];
    for (const deviceId of staleDeviceIds) {
      const refreshedDevice = refreshedById.get(deviceId);
      if (!refreshedDevice || isDeviceObservationStaleByAge(refreshedDevice, nowMs)) {
        stillStaleAfterRefreshDevices += 1;
        stillStaleDeviceIds.push(deviceId);
      } else {
        freshAfterRefreshDevices += 1;
        // Recovered: clear backoff so the next still-stale cycle re-emits.
        this.staleRefreshLogLastEmitMsById.delete(deviceId);
      }
    }

    // Emit only when at least one still-stale device is outside its per-device
    // backoff window. The tally itself is independent of the emit decision so
    // the counter remains accurate even when the log line is suppressed.
    const devicesDueForLog = stillStaleDeviceIds.filter((deviceId) => {
      const lastEmitMs = this.staleRefreshLogLastEmitMsById.get(deviceId);
      return lastEmitMs === undefined
        || (nowMs - lastEmitMs) >= STALE_OBSERVATION_REFRESH_LOG_BACKOFF_MS;
    });
    if (devicesDueForLog.length === 0) return;

    for (const deviceId of devicesDueForLog) {
      this.staleRefreshLogLastEmitMsById.set(deviceId, nowMs);
    }

    this.deps.getStructuredLogger('devices')?.info({
      event: 'stale_device_observation_refresh',
      staleDevices: staleDevices.length,
      devicesTotal: snapshot.length,
      refreshedDevices: staleDevices.length,
      freshAfterRefreshDevices,
      stillStaleAfterRefreshDevices,
      loggedStillStaleDevices: devicesDueForLog.length,
    });
  }

  private pruneStaleRefreshLogBackoff(
    managedSnapshot: TargetDeviceSnapshot[],
    nowMs: number,
  ): void {
    const staleManagedIds = new Set(
      managedSnapshot
        .filter((device) => isDeviceObservationStaleByAge(device, nowMs))
        .map((device) => device.id),
    );
    for (const deviceId of this.staleRefreshLogLastEmitMsById.keys()) {
      if (!staleManagedIds.has(deviceId)) {
        this.staleRefreshLogLastEmitMsById.delete(deviceId);
      }
    }
  }

  scheduleNextSnapshotRefresh(): void {
    const now = this.deps.getNow();
    const currentMinute = now.getMinutes();
    const nextMinute = SNAPSHOT_REFRESH_MINUTE_INTERVALS.find((minute) => minute > currentMinute);

    const next = new Date(now);
    if (nextMinute !== undefined) {
      next.setMinutes(nextMinute, 0, 0);
    } else {
      next.setHours(now.getHours() + 1, SNAPSHOT_REFRESH_MINUTE_INTERVALS[0], 0, 0);
    }

    const scheduledTimer = this.deps.timers.registerTimeout('snapshotRefresh', setTimeout(async () => {
      if (this.snapshotRefreshTimer !== scheduledTimer || this.staleObservationRefreshStopped) return;
      let refreshed = false;
      try {
        await this.refreshTargetDevicesSnapshot({ targeted: true });
        refreshed = true;
      } catch (error) {
        this.deps.getStructuredLogger('snapshot')?.error({
          event: 'periodic_snapshot_refresh_failed',
          err: normalizeError(error),
        });
      } finally {
        this.deps.logPeriodicStatus({ includeDeviceHealth: refreshed });
        if (this.snapshotRefreshTimer === scheduledTimer) {
          this.deps.timers.clear('snapshotRefresh');
          this.snapshotRefreshTimer = undefined;
        }
        if (!this.staleObservationRefreshStopped) {
          this.scheduleNextSnapshotRefresh();
        }
      }
    }, next.getTime() - now.getTime()));
    this.snapshotRefreshTimer = scheduledTimer;
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
    if (this.postActuationRefreshTimer) {
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
    this.postActuationRefreshTimer = this.deps.timers.registerTimeout('postActuationRefresh', setTimeout(async () => {
      this.postActuationRefreshTimer = undefined;
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
    }, POST_ACTUATION_REFRESH_DELAY_MS));
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
    await deviceManager.refreshSnapshot({
      includeLivePower: options.fast !== true,
      targetedRefresh: options.targeted,
    });

    const snapshot = this.deps.getLatestTargetSnapshot();
    this.deps.disableUnsupportedDevices(snapshot);
    this.deps.seedMissingModeTargets(snapshot);
    const enforcedSnapshot = snapshot.map((device) => ({
      ...device,
      managed: this.deps.resolveManagedState(device.id),
      controllable: this.deps.isCapacityControlEnabled(device.id),
    }));
    this.logDeviceFreshnessTransitions(
      enforcedSnapshot.filter((device) => device.managed !== false),
      'snapshot_refresh',
    );
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
    await this.recordImplicitHomeyEnergySample(options);
  }

  private async recordImplicitHomeyEnergySample(
    options: RefreshTargetDevicesSnapshotOptions,
  ): Promise<void> {
    if (
      options.recordHomeyEnergySample === false
      || this.deps.homey.settings.get('power_source') !== 'homey_energy'
    ) {
      return;
    }

    const homePowerW = this.deps.getHomePowerW();
    if (typeof homePowerW === 'number') {
      await this.deps.recordPowerSample(homePowerW);
    }
  }

  private startStaleObservationRefreshFallback(): void {
    this.staleObservationRefreshStopped = false;
    if (this.staleObservationRefreshTimer) {
      this.deps.timers.clear('staleObservationRefresh');
      this.staleObservationRefreshTimer = undefined;
    }
    this.scheduleStaleObservationRefreshFallback();
  }

  private scheduleStaleObservationRefreshFallback(): void {
    if (this.staleObservationRefreshStopped) return;

    this.staleObservationRefreshTimer = this.deps.timers.registerTimeout(
      'staleObservationRefresh',
      setTimeout(async () => {
        this.deps.timers.clear('staleObservationRefresh');
        this.staleObservationRefreshTimer = undefined;
        try {
          await this.refreshStaleDeviceObservations();
        } catch (error) {
          this.deps.getStructuredLogger('snapshot')?.error({
            event: 'stale_device_observation_refresh_failed',
            err: normalizeError(error),
          });
        } finally {
          if (!this.staleObservationRefreshStopped) {
            this.scheduleStaleObservationRefreshFallback();
          }
        }
      }, STALE_OBSERVATION_FALLBACK_REFRESH_INTERVAL_MS),
    );
  }

  private logDeviceFreshnessTransitions(
    snapshot: TargetDeviceSnapshot[],
    source: string,
    nowMs = this.deps.getNow().getTime(),
  ): void {
    const activeDeviceIds = new Set(snapshot.map((device) => device.id));
    for (const deviceId of this.deviceObservationStaleById.keys()) {
      if (!activeDeviceIds.has(deviceId)) this.deviceObservationStaleById.delete(deviceId);
    }

    for (const device of snapshot) {
      const isStale = isDeviceObservationStale(device);
      const wasStale = this.deviceObservationStaleById.get(device.id);
      this.deviceObservationStaleById.set(device.id, isStale);
      if (wasStale === undefined || wasStale === isStale) continue;

      const lastObservationMs = getLatestDeviceObservationMs(device);
      const ageMs = typeof lastObservationMs === 'number' ? Math.max(0, nowMs - lastObservationMs) : null;
      const planDevice = this.deps
        .getPlanService()
        ?.getLatestPlanSnapshot()
        ?.devices.find((entry) => entry.id === device.id);
      this.deps.getStructuredLogger('devices')?.info({
        event: isStale ? 'device_became_stale' : 'device_became_fresh',
        deviceId: device.id,
        deviceName: device.name,
        ageMs,
        lastObservationAt: typeof lastObservationMs === 'number' ? new Date(lastObservationMs).toISOString() : null,
        source,
        currentPowerW: resolveSnapshotPowerW(device),
        isControlled: this.deps.isCapacityControlEnabled(device.id),
        isShed: planDevice ? planDevice.plannedState === 'shed' : null,
      });
    }
  }
}

function resolveSnapshotPowerW(device: TargetDeviceSnapshot): number | null {
  const kw = typeof device.measuredPowerKw === 'number'
    ? device.measuredPowerKw
    : device.powerKw;
  return typeof kw === 'number' && Number.isFinite(kw) ? kw * 1000 : null;
}
