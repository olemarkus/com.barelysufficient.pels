import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';

/** Publishes transport changes and owns the wiring subscriptions for them. */
export class TransportNotifications {
  private zoneTreeCommitted?: () => void;
  private deviceZoneChanged?: () => void;

  constructor(
    private readonly snapshotMutated: (snapshot: TargetDeviceSnapshot, nowMs: number) => void,
    /**
     * The transport's own zone-tree catch-up: a device that moved into a zone
     * the cached tree does not contain gets the tree refetched at once, rather
     * than waiting for the next refresh's tail fetch.
     */
    private readonly zoneEntered: (zoneId: string) => void,
  ) {}

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
  /** A device's zone changed to `zoneId` (null: it reports none). */
  notifyDeviceZoneChanged(zoneId: string | null): void {
    if (zoneId !== null) this.zoneEntered(zoneId);
    this.deviceZoneChanged?.();
  }
}
