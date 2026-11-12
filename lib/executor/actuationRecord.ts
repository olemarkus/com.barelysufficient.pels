import type { RestoreDrawEvidence } from '../ports/actuationHistory';

/**
 * Executor-owned command history and in-flight work, one per home.
 * Planner consumers receive only ActuationHistoryRead; persistence receives
 * ActuationHydration so a delayed legacy import updates the same live record.
 * These clocks describe actual writes, independently of planner shed membership.
 */
export class ActuationRecord {
  /**
   * The last time PELS wrote a device, any direction. The one persisted clock
   * here (`lib/plan/lastControlledStore.ts`): the store hydrates it at boot through
   * `loadLastControlled`, and the executor persists the map after each apply.
   */
  lastDeviceControlledMs: Record<string, number> = {};

  /**
   * The timestamp the executor last actually turned a device off for
   * capacity — `recordShedActuation` on a real turn-off, plus the degenerate
   * no-onoff shed path in `binaryExecutor`. Drives the actuation-recency
   * readers: the cooldown countdown card, the reconcile window, the
   * recent-shed restore back-off, and the shortfall reason line.
   */
  lastDeviceShedMs: Record<string, number> = {};

  /** The last restore of each device — a step adjustment upward stamps it as well as a turn-on. */
  lastDeviceRestoreMs: Record<string, number> = {};

  /** Binary power may arrive between dispatch and the ON confirmation that starts pacing. */
  private readonly binaryRestoreDrawEvidenceFromMs: Record<string, number> = {};

  /** The last restore of any device — the restore cooldown's anchor. */
  lastRestoreMs: number | null = null;

  /**
   * Binary activation attempts for dual-control stepped loads. Separate from
   * `lastDeviceRestoreMs`, which step adjustments also stamp: this cursor
   * prevents an activation-time OFF/reset echo from immediately reissuing a
   * toggle-style binary ON before the post-activation step lands.
   */
  lastSteppedBinaryRestoreAttemptMs: Record<string, number> = {};

  private readonly pendingSheds = new Set<string>();

  private readonly pendingRestores = new Set<string>();

  /**
   * Hydration from the userdata store (`lib/plan/lastControlledStore.ts`),
   * already validated: at boot, and once more with the stamps a legacy import
   * brings if it lands later in the run.
   */
  loadLastControlled(stored: Readonly<Record<string, number>>): void {
    this.lastDeviceControlledMs = { ...stored };
  }

  beginShed(deviceId: string): void {
    this.pendingSheds.add(deviceId);
  }

  endShed(deviceId: string): void {
    this.pendingSheds.delete(deviceId);
  }

  isShedInFlight(deviceId: string): boolean {
    return this.pendingSheds.has(deviceId);
  }

  beginRestore(deviceId: string): void {
    this.pendingRestores.add(deviceId);
  }

  endRestore(deviceId: string): void {
    this.pendingRestores.delete(deviceId);
  }

  isRestoreInFlight(deviceId: string): boolean {
    return this.pendingRestores.has(deviceId);
  }

  /** Whether any shed or restore command is in flight. */
  hasInFlight(): boolean {
    return this.pendingSheds.size > 0 || this.pendingRestores.size > 0;
  }

  /** PELS wrote this device, in either direction. */
  markControlled(deviceId: string, nowMs: number): void {
    this.lastDeviceControlledMs[deviceId] = nowMs;
  }

  /** Stamp the actuation-time shed clock for a device (executor turn-off). */
  markShed(deviceId: string, nowMs: number): void {
    this.lastDeviceShedMs[deviceId] = nowMs;
  }

  /** Clear the actuation-time shed clock for a device. */
  clearShed(deviceId: string): void {
    delete this.lastDeviceShedMs[deviceId];
  }

  /** A device was restored: both the per-device clock and the global anchor move. */
  markRestore(deviceId: string, nowMs: number): void {
    this.lastRestoreMs = nowMs;
    this.lastDeviceRestoreMs[deviceId] = nowMs;
    delete this.binaryRestoreDrawEvidenceFromMs[deviceId];
  }

  /** Confirmation starts pacing; the corresponding dispatch starts its power-evidence window. */
  markConfirmedBinaryRestore(deviceId: string, dispatchedAtMs: number, confirmedAtMs: number): void {
    const evidenceFromMs = Math.max(
      dispatchedAtMs,
      this.resolveDrawEvidenceFromMs(deviceId, this.lastDeviceRestoreMs[deviceId] ?? dispatchedAtMs),
    );
    this.markRestore(deviceId, confirmedAtMs);
    // A delayed ON confirmation cannot make power from before a newer step-up count.
    this.binaryRestoreDrawEvidenceFromMs[deviceId] = evidenceFromMs;
  }

  readRestoreDrawEvidence(): readonly RestoreDrawEvidence[] {
    return Object.entries(this.lastDeviceRestoreMs).map(([deviceId, restoredAtMs]) => ({
      deviceId, restoredAtMs, drawEvidenceFromMs: this.resolveDrawEvidenceFromMs(deviceId, restoredAtMs),
    }));
  }

  private resolveDrawEvidenceFromMs(deviceId: string, restoredAtMs: number): number {
    return this.binaryRestoreDrawEvidenceFromMs[deviceId] ?? restoredAtMs;
  }

  /** Whether PELS shed or restored any device at or after `sinceMs` this run. */
  hasShedOrRestoreSince(sinceMs: number): boolean {
    return (this.lastRestoreMs !== null && this.lastRestoreMs >= sinceMs)
      || Object.values(this.lastDeviceShedMs).some((shedMs) => shedMs >= sinceMs);
  }

  /** Record a dual-control stepped load's binary activation attempt. */
  markSteppedBinaryRestoreAttempt(deviceId: string, nowMs: number): void {
    this.lastSteppedBinaryRestoreAttemptMs[deviceId] = nowMs;
  }

  /** Whether a dual-control stepped load was sent binary ON within `withinMs`. */
  hasRecentSteppedBinaryRestoreAttempt(deviceId: string, nowMs: number, withinMs: number): boolean {
    const attemptedAtMs = this.lastSteppedBinaryRestoreAttemptMs[deviceId];
    return attemptedAtMs !== undefined && nowMs - attemptedAtMs < withinMs;
  }
}

