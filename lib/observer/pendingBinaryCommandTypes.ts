/**
 * Observer-owned pending-binary-command types and freshness predicates.
 *
 * Lives in `lib/observer/` because:
 *  - The store that holds these entries is observer-owned (see PR #4 of
 *    `notes/state-management/observer-transport-split.md`).
 *  - The freshness rule (`isPendingBinaryCommandActive`) is a pure
 *    observer concern: "is this pending entry still inside its
 *    confirmation window?". Plan/executor consumers read it through this
 *    helper without owning the policy.
 *
 * Plan/executor consume these types and freshness helpers via direct
 * import — observer is a leaf so the consumer direction is allowed.
 *
 * Constants are inlined here rather than imported from `lib/plan/` so
 * observer remains a leaf (cruiser rule `no-observer-to-peer`).
 */

/**
 * Observation sources that can settle a pending command. Identical to
 * `PendingTargetObservationSource` in `lib/plan/planTypes.ts`; defined
 * here so observer code does not import the plan layer. Plan re-exports
 * this from `planTypes.ts` for backward compatibility.
 */
export type PendingObservationSource =
  | 'rebuild'
  | 'snapshot_refresh'
  | 'realtime_capability'
  | 'device_update';

/**
 * Default local-device confirmation window. Mirrors the pre-split
 * `BINARY_COMMAND_PENDING_MS` constant from `lib/plan/planConstants.ts`,
 * which still re-exports the same number for legacy callers.
 */
export const BINARY_COMMAND_PENDING_MS = 15000;
export const CLOUD_BINARY_COMMAND_PENDING_MS = 75 * 1000;

export type CommunicationModel = 'local' | 'cloud' | undefined;

export type PendingBinaryCommandLogContext = 'capacity' | 'capacity_control_off';
export type PendingBinaryCommandRestoreSource = 'shed_state' | 'current_plan';
export type PendingBinaryCommandActuationMode = 'plan' | 'reconcile';

export type PendingBinaryCommand = {
  capabilityId: 'onoff' | 'evcharger_charging';
  desired: boolean;
  startedMs: number;
  pendingMs?: number;
  flowBackedControl?: boolean;
  logContext?: PendingBinaryCommandLogContext;
  restoreSource?: PendingBinaryCommandRestoreSource;
  actuationMode?: PendingBinaryCommandActuationMode;
  reason?: string;
  /**
   * True when this pending command was issued by the smart-task lifecycle-end
   * disable path, not a capacity shed. `handleConfirmedBinaryCommand` reads it so
   * a deferred flow-backed off-confirmation routes through the diagnostic-only
   * release recorder and does NOT stamp the capacity cooldown markers
   * (`lastInstabilityMs` / `lastDeviceShedMs`). A lifecycle disable is a planning
   * decision, not capacity pressure.
   */
  lifecycleRelease?: boolean;
  lastObservedValue?: boolean | string;
  lastObservedSource?: PendingObservationSource;
  lastObservedAtMs?: number;
};


export function resolveBinaryCommandPendingMs(communicationModel?: CommunicationModel): number {
  return communicationModel === 'cloud' ? CLOUD_BINARY_COMMAND_PENDING_MS : BINARY_COMMAND_PENDING_MS;
}

export function getPendingBinaryCommandWindowMs(
  pending: PendingBinaryCommand,
  communicationModel?: CommunicationModel,
): number {
  return pending.pendingMs ?? resolveBinaryCommandPendingMs(communicationModel);
}

export function isPendingBinaryCommandActive(params: {
  pending?: PendingBinaryCommand;
  nowMs?: number;
  communicationModel?: CommunicationModel;
}): boolean {
  const { pending, nowMs = Date.now(), communicationModel } = params;
  if (!pending) return false;
  return (nowMs - pending.startedMs) < getPendingBinaryCommandWindowMs(pending, communicationModel);
}
