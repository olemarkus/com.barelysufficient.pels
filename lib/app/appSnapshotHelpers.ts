import type Homey from 'homey';
import type { DeviceManager } from '../core/deviceManager';
import type { Logger as PinoLogger } from '../logging/logger';
import type { PlanEngine } from '../plan/planEngine';
import { TARGET_CONFIRMATION_STUCK_POLL_MS } from '../plan/planConstants';
import { getLatestDeviceObservationMs, isDeviceObservationStale } from '../plan/planObservationPolicy';
import type { PlanService } from '../plan/planService';
import type { TargetDeviceSnapshot } from '../utils/types';
import { toStableFingerprint } from '../utils/stableFingerprint';

const SNAPSHOT_REFRESH_MINUTE_INTERVALS = [25, 55];
const TARGET_CONFIRMATION_POLL_INTERVAL_MS = TARGET_CONFIRMATION_STUCK_POLL_MS;
const STALE_OBSERVATION_FALLBACK_REFRESH_INTERVAL_MS = 60 * 1000;
const POST_ACTUATION_REFRESH_DELAY_MS = 5_000;

export type RefreshTargetDevicesSnapshotOptions = {
  fast?: boolean;
  targeted?: boolean;
  recordHomeyEnergySample?: boolean;
};

function toPersistedTargetSnapshotFingerprint(value: unknown): string {
  if (!Array.isArray(value)) return toStableFingerprint(value);
  return toStableFingerprint(value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const {
      lastFreshDataMs: _lastFreshDataMs,
      lastUpdated: _lastUpdated,
      lastLocalWriteMs: _lastLocalWriteMs,
      ...rest
    } = entry as Record<string, unknown>;
    return rest;
  }));
}

export class AppSnapshotHelpers {
  private snapshotRefreshTimer?: ReturnType<typeof setTimeout>;
  private staleObservationRefreshTimer?: ReturnType<typeof setTimeout>;
  private staleObservationRefreshStopped = true;
  private targetConfirmationPollInterval?: ReturnType<typeof setInterval>;
  private isSnapshotRefreshing = false;
  private snapshotRefreshPending = false;
  private postActuationRefreshTimer?: ReturnType<typeof setTimeout>;
  private deviceObservationStaleById = new Map<string, boolean>();

  constructor(private readonly deps: {
    homey: Homey.App['homey'];
    getDeviceManager: () => DeviceManager | undefined;
    getPlanEngine: () => PlanEngine | undefined;
    getPlanService: () => PlanService | undefined;
    getLatestTargetSnapshot: () => TargetDeviceSnapshot[];
    resolveManagedState: (deviceId: string) => boolean;
    isCapacityControlEnabled: (deviceId: string) => boolean;
    getStructuredLogger: (component: string) => PinoLogger | undefined;
    logDebug: (topic: 'devices' | 'plan', ...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    getNow: () => Date;
    logPeriodicStatus: (options?: { includeDeviceHealth?: boolean }) => void;
    disableUnsupportedDevices: (snapshot: TargetDeviceSnapshot[]) => void;
    recordPowerSample: (powerW: number) => Promise<void>;
  }) {}

  getPostActuationRefreshTimer(): ReturnType<typeof setTimeout> | undefined {
    return this.postActuationRefreshTimer;
  }

  startPeriodicSnapshotRefresh(): void {
    if (this.snapshotRefreshTimer) clearTimeout(this.snapshotRefreshTimer);
    this.scheduleNextSnapshotRefresh();
    this.startStaleObservationRefreshFallback();

    if (this.targetConfirmationPollInterval) clearInterval(this.targetConfirmationPollInterval);
    this.targetConfirmationPollInterval = setInterval(() => {
      this.pollStuckTargetConfirmations()
        .catch((error) => this.deps.error('Pending target confirmation poll failed', error));
    }, TARGET_CONFIRMATION_POLL_INTERVAL_MS);
  }

  stop(): void {
    this.staleObservationRefreshStopped = true;
    this.snapshotRefreshPending = false;
    if (this.snapshotRefreshTimer) {
      clearTimeout(this.snapshotRefreshTimer);
      this.snapshotRefreshTimer = undefined;
    }
    if (this.staleObservationRefreshTimer) {
      clearTimeout(this.staleObservationRefreshTimer);
      this.staleObservationRefreshTimer = undefined;
    }
    if (this.targetConfirmationPollInterval) {
      clearInterval(this.targetConfirmationPollInterval);
      this.targetConfirmationPollInterval = undefined;
    }
    if (this.postActuationRefreshTimer) {
      clearTimeout(this.postActuationRefreshTimer);
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
      this.deps.logDebug('devices', 'Snapshot refresh already in progress, queued another refresh');
      return;
    }

    this.isSnapshotRefreshing = true;
    try {
      do {
        this.snapshotRefreshPending = false;
        await this.runSnapshotRefreshCycle(deviceManager, options);
      } while (this.snapshotRefreshPending && !this.staleObservationRefreshStopped);
    } finally {
      this.isSnapshotRefreshing = false;
      this.snapshotRefreshPending = false;
    }
  }

  async refreshStaleDeviceObservations(): Promise<void> {
    if (!this.deps.getDeviceManager() || this.isSnapshotRefreshing) return;

    const nowMs = this.deps.getNow().getTime();
    const snapshot = this.deps.getLatestTargetSnapshot().filter((device) => this.deps.resolveManagedState(device.id));
    this.logDeviceFreshnessTransitions(snapshot, 'stale_observation_check', nowMs);
    const staleDevices = snapshot.filter((device) => isDeviceObservationStale(device));
    if (staleDevices.length === 0) return;

    this.deps.logDebug(
      'devices',
      `Refreshing target devices snapshot because ${staleDevices.length}/${snapshot.length} managed devices are stale`,
    );
    const staleDeviceIds = new Set(staleDevices.map((device) => device.id));
    await this.refreshTargetDevicesSnapshot({ targeted: true });

    const refreshedSnapshot = this.deps
      .getLatestTargetSnapshot()
      .filter((device) => this.deps.resolveManagedState(device.id));
    const refreshedById = new Map(refreshedSnapshot.map((device) => [device.id, device]));
    let freshAfterRefreshDevices = 0;
    let stillStaleAfterRefreshDevices = 0;
    for (const deviceId of staleDeviceIds) {
      const refreshedDevice = refreshedById.get(deviceId);
      if (!refreshedDevice || isDeviceObservationStale(refreshedDevice)) {
        stillStaleAfterRefreshDevices += 1;
      } else {
        freshAfterRefreshDevices += 1;
      }
    }

    this.deps.getStructuredLogger('devices')?.info({
      event: 'stale_device_observation_refresh',
      staleDevices: staleDevices.length,
      devicesTotal: snapshot.length,
      refreshedDevices: staleDevices.length,
      freshAfterRefreshDevices,
      stillStaleAfterRefreshDevices,
    });
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

    const scheduledTimer = setTimeout(async () => {
      if (this.snapshotRefreshTimer !== scheduledTimer || this.staleObservationRefreshStopped) return;
      let refreshed = false;
      try {
        await this.refreshTargetDevicesSnapshot({ targeted: true });
        refreshed = true;
      } catch (error) {
        this.deps.error('Periodic snapshot refresh failed', error);
      } finally {
        this.deps.logPeriodicStatus({ includeDeviceHealth: refreshed });
        if (this.snapshotRefreshTimer === scheduledTimer) {
          this.snapshotRefreshTimer = undefined;
        }
        if (!this.staleObservationRefreshStopped) {
          this.scheduleNextSnapshotRefresh();
        }
      }
    }, next.getTime() - now.getTime());
    this.snapshotRefreshTimer = scheduledTimer;
  }

  async pollStuckTargetConfirmations(): Promise<void> {
    if (!this.deps.getPlanEngine()?.hasPendingTargetCommandsOlderThan(TARGET_CONFIRMATION_STUCK_POLL_MS)) {
      return;
    }

    this.deps.logDebug(
      'devices',
      `Pending target confirmation older than ${Math.round(TARGET_CONFIRMATION_STUCK_POLL_MS / 1000)}s; `
      + 'polling device state',
    );
    await this.refreshTargetDevicesSnapshot({ targeted: true });
  }

  schedulePostActuationRefresh(): void {
    if (this.postActuationRefreshTimer) {
      this.deps.logDebug('plan', 'Post-actuation snapshot refresh already scheduled');
      return;
    }

    this.deps.logDebug(
      'plan',
      `Scheduling post-actuation snapshot refresh in ${Math.round(POST_ACTUATION_REFRESH_DELAY_MS / 1000)} s`,
    );
    this.postActuationRefreshTimer = setTimeout(async () => {
      this.postActuationRefreshTimer = undefined;
      this.deps.logDebug('plan', 'Running post-actuation targeted snapshot refresh');
      try {
        await this.refreshTargetDevicesSnapshot({ targeted: true, recordHomeyEnergySample: false });
      } catch (error) {
        this.deps.error('Post-actuation snapshot refresh failed:', error);
      }
    }, POST_ACTUATION_REFRESH_DELAY_MS);
  }

  private async runSnapshotRefreshCycle(
    deviceManager: DeviceManager,
    options: RefreshTargetDevicesSnapshotOptions,
  ): Promise<void> {
    this.deps.logDebug('devices', 'Refreshing target devices snapshot');
    await deviceManager.refreshSnapshot({
      includeLivePower: options.fast !== true,
      targetedRefresh: options.targeted,
    });

    const snapshot = this.deps.getLatestTargetSnapshot();
    this.logDeviceFreshnessTransitions(
      snapshot.filter((device) => this.deps.resolveManagedState(device.id)),
      'snapshot_refresh',
    );
    await this.deps.getPlanService()?.syncLivePlanState('snapshot_refresh');
    this.deps.getPlanService()?.syncHeadroomCardState({
      devices: snapshot,
      cleanupMissingDevices: true,
    });
    this.persistTargetSnapshot(snapshot, options);
    this.deps.disableUnsupportedDevices(snapshot);
    await this.recordImplicitHomeyEnergySample(deviceManager, options);
  }

  private persistTargetSnapshot(
    snapshot: TargetDeviceSnapshot[],
    options: RefreshTargetDevicesSnapshotOptions,
  ): void {
    const existingSnapshot = this.deps.homey.settings.get('target_devices_snapshot') as unknown;
    if (
      toPersistedTargetSnapshotFingerprint(existingSnapshot)
      !== toPersistedTargetSnapshotFingerprint(snapshot)
    ) {
      this.deps.homey.settings.set('target_devices_snapshot', snapshot);
      this.deps.getStructuredLogger('devices')?.info({
        event: 'target_devices_snapshot_written',
        reasonCode: options.targeted === true ? 'targeted_refresh' : 'snapshot_refresh',
        deviceCount: snapshot.length,
        targetedRefresh: options.targeted === true,
      });
      return;
    }

    this.deps.getStructuredLogger('devices')?.debug({
      event: 'target_devices_snapshot_write_skipped',
      reasonCode: 'unchanged',
      deviceCount: snapshot.length,
      targetedRefresh: options.targeted === true,
    });
    this.deps.logDebug('devices', 'Target devices snapshot unchanged, skipping settings write');
  }

  private async recordImplicitHomeyEnergySample(
    deviceManager: DeviceManager,
    options: RefreshTargetDevicesSnapshotOptions,
  ): Promise<void> {
    if (
      options.recordHomeyEnergySample === false
      || this.deps.homey.settings.get('power_source') !== 'homey_energy'
    ) {
      return;
    }

    const homePowerW = deviceManager.getHomePowerW();
    if (typeof homePowerW === 'number') {
      await this.deps.recordPowerSample(homePowerW);
    }
  }

  private startStaleObservationRefreshFallback(): void {
    this.staleObservationRefreshStopped = false;
    if (this.staleObservationRefreshTimer) clearTimeout(this.staleObservationRefreshTimer);
    this.scheduleStaleObservationRefreshFallback();
  }

  private scheduleStaleObservationRefreshFallback(): void {
    if (this.staleObservationRefreshStopped) return;

    this.staleObservationRefreshTimer = setTimeout(async () => {
      try {
        await this.refreshStaleDeviceObservations();
      } catch (error) {
        this.deps.error('Stale device observation refresh failed', error);
      } finally {
        if (!this.staleObservationRefreshStopped) {
          this.scheduleStaleObservationRefreshFallback();
        }
      }
    }, STALE_OBSERVATION_FALLBACK_REFRESH_INTERVAL_MS);
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
