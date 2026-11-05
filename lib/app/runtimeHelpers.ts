import type { SteppedDeviceControl } from '../executor/steppedDeviceControl';
import type { DeviceControlProjection } from '../planInput/deviceControlProjection';
import type { SnapshotRefreshOptions } from '../device/snapshotRefreshScheduler';

/** The existing device-control collaborators exposed at the application boundary. */
export type DeviceControlHelpers = Pick<SteppedDeviceControl,
  | 'getSteppedLoadProfile'
  | 'getSteppedLoadCommandSession'
  | 'markSteppedLoadDesiredStepIssued'
  | 'hasPendingTargetPowerProbe'
  | 'reconcileTargetPowerReachability'
  | 'reportSteppedLoadActualStep'
> & Pick<DeviceControlProjection, 'decorateTargetSnapshotList' | 'getLifecycleFallbackDevice'>;

/** Snapshot scheduling commands used by application consumers, independent of wiring. */
export type AppSnapshotControl = {
  hasPendingPostActuationRefresh(): boolean;
  startPeriodicSnapshotRefresh(): void;
  stop(): void;
  refreshTargetDevicesSnapshot(options?: SnapshotRefreshOptions): Promise<void>;
  schedulePostActuationRefresh(): void;
  scheduleTargetPowerProbeSettlement(dueAtMs: number): void;
  scheduleTargetPowerProbe(): void;
};
