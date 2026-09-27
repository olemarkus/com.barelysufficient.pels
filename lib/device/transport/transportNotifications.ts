import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';

/** Publishes transport changes and owns the wiring subscriptions for them. */
export class TransportNotifications {
  private zoneTreeCommitted?: () => void;
  private deviceZoneChanged?: () => void;

  constructor(private readonly snapshotMutated: (snapshot: TargetDeviceSnapshot, nowMs: number) => void) {}

  snapshotChanged(snapshot: TargetDeviceSnapshot, nowMs: number): void {
    this.snapshotMutated(snapshot, nowMs);
  }

  setZoneTreeCommitted(listener: (() => void) | undefined): void {
    this.zoneTreeCommitted = listener;
  }

  setDeviceZoneChanged(listener: (() => void) | undefined): void {
    this.deviceZoneChanged = listener;
  }

  notifyZoneTreeCommitted(): void { this.zoneTreeCommitted?.(); }
  notifyDeviceZoneChanged(): void { this.deviceZoneChanged?.(); }
}
