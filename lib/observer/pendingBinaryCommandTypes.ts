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
 * Plan/executor consume these types and freshness helpers via a direct
 * dependency — observer is a leaf so the consumer direction is allowed.
 *
 * The window itself is the observer-owned `CONTROL_COMMAND_CONFIRMATION_MS`
 * (`./controlCommandConfirmation`); entries do not carry a copy — there is
 * one window for every device and axis, so a stored per-entry number could
 * only ever restate or contradict it.
 */
import { CONTROL_COMMAND_CONFIRMATION_MS } from './controlCommandConfirmation';

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

export type PendingBinaryCommandLogContext = 'capacity' | 'capacity_control_off';
export type PendingBinaryCommandRestoreSource = 'shed_state' | 'current_plan';

export type PendingBinaryCommand = {
  dispatchState: 'dispatching' | 'accepted';
  desired: boolean;
  startedMs: number;
  logContext?: PendingBinaryCommandLogContext;
  restoreSource?: PendingBinaryCommandRestoreSource;
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

export function isPendingBinaryCommandActive(params: {
  pending?: PendingBinaryCommand;
  nowMs?: number;
}): boolean {
  const { pending, nowMs = Date.now() } = params;
  if (!pending) return false;
  return (nowMs - pending.startedMs) < CONTROL_COMMAND_CONFIRMATION_MS;
}
