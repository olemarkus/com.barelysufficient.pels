import { isNumberMap } from '../utils/appTypeGuards';

/**
 * What the executor did to which device, and when — the actuation-time clocks
 * and the in-flight commands the planner's cooldowns, back-offs, cards and
 * convergence reads consult. One per `PlanEngineState`. Written by the
 * executor through the mutators below (and hydrated once, when its engine is
 * created, from the persisted last-controlled map); read by the planner by
 * reference. The clock
 * maps stay public for the same reason `PlanEngineState`'s do: the planner
 * reads them transparently across `lib/plan`. The in-flight sets are private:
 * the executor begins and ends them, and the planner asks only whether
 * anything is in flight.
 *
 * These are ACTUATION clocks. "Is this device in shed posture?" is the
 * planner's decision-time question (`PlanEngineState.shedDecidedMs`): a device
 * the plan decided to shed but that was already off (write skipped) has no
 * entry here.
 *
 * Hosted on the planner's state because the planner reads it and may not
 * import the executor; under the planner/executor seam train the executor
 * owns this record and the planner declares a read-only view of the clocks,
 * so nothing that decides belongs here.
 */
export class ActuationRecord {
  /**
   * The last time PELS wrote a device, any direction. The one persisted clock
   * here (`DEVICE_LAST_CONTROLLED_MS`): the wiring hydrates it at boot through
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
   * Boot hydration from the persisted `DEVICE_LAST_CONTROLLED_MS` read. The
   * record classifies the raw settings value itself: a map of finite numbers
   * is the history, anything else (absent, malformed) starts empty.
   */
  loadLastControlled(stored: unknown): void {
    this.lastDeviceControlledMs = isNumberMap(stored) ? { ...stored } : {};
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

/** The read a consumer that only asks "is anything in flight?" is handed. */
export type ActuationPendingRead = Pick<ActuationRecord, 'hasInFlight'>;
