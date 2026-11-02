import type { DeviceDescriptor, ObservedDeviceState } from '../../packages/contracts/src/types';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import {
  isBinaryControlled,
  resolveBinaryCommandCurrentOn,
} from '../../packages/shared-domain/src/binaryControlState';
import { getDebugEmitter } from '../logging/logger';

/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

/**
 * The decomposed snapshot surface the binary-command preflight reads: observed
 * truth (`targets`/`binaryControl`) plus the descriptor config the skip/route
 * gates consult. Narrower than the raw producer `TargetDeviceSnapshot` — the
 * full snapshot remains assignable, so callers pass it unchanged.
 */
export type BinaryControlDecisionSnapshot = Pick<ObservedDeviceState, 'targets' | 'binaryControl'>
  & Pick<
    DeviceDescriptor,
    'capabilities' | 'canSetControl'
  > & { currentOn?: boolean };

/**
 * The observer's binary axis for one device, live — the only observed read the
 * binary-command preflight makes. `undefined` for a device the observer has not
 * recorded; the decision then falls back to the snapshot the caller carried
 * into the cycle. Stage 5 of the snapshot decomposition: this used to be the
 * transport's `getSnapshotByDeviceId`, which handed the decision the whole raw
 * snapshot to read one field off.
 */
export type ObservedBinaryControlRead = (
  deviceId: string,
) => Pick<ObservedDeviceState, 'binaryControl'> | undefined;

type BinaryControlPlan = { canSet: boolean };

type BinaryControlPlanInput = Pick<BinaryControlDecisionSnapshot, 'binaryControl' | 'currentOn' | 'canSetControl'>;

/**
 * Compatibility preflight over the executor's accepted snapshot. Device-side
 * capability resolution stays with the device owner; the actuator checks the
 * current write surface before dispatch. Keep a missing axis distinct from an
 * unwritable one because binary shedding records those outcomes differently.
 */
export function getBinaryControlPlan(snapshot?: BinaryControlPlanInput): BinaryControlPlan | null {
  if (!snapshot || (!isBinaryControlled(snapshot) && typeof snapshot.currentOn !== 'boolean')) return null;
  return { canSet: snapshot.canSetControl !== false };
}

type BinaryControlLogContext = 'capacity' | 'capacity_control_off';

/**
 * One requested binary command. Executor preflight checks observed and pending
 * state before dispatch records the provisional pending entry. Lifecycle release
 * carries its distinct accounting through direct and deferred confirmation.
 */
export type BinaryControlDecision = {
  deviceId: string;
  name: string;
  desired: boolean;
  logContext: BinaryControlLogContext;
  /**
   * True when this decision comes from the smart-task lifecycle-end disable path
   * rather than a capacity shed. Carried onto the pending entry so the executor's
   * direct and deferred (flow-backed) confirmation paths both record via the
   * diagnostic-only release recorder and never stamp the capacity cooldown markers.
   */
  lifecycleRelease?: boolean;
};

/**
 * The two live reads the binary-command preflight makes. The executor's command
 * context carries both under these names, so it passes itself.
 */
type BinaryControlDeps = {
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  getObservedState: ObservedBinaryControlRead;
};

/** Skip unsupported, already-matched or already-pending writes without changing the requested state. */
export function decideBinaryControl(
  deps: BinaryControlDeps,
  command: BinaryControlDecision,
  snapshot: BinaryControlDecisionSnapshot | undefined,
  forceAgainstReleasedOpposing: boolean,
): BinaryControlDecision | null {
  const controlPlan = getBinaryControlPlan(snapshot);
  const decision: BinaryControlDecision = {
    deviceId: command.deviceId,
    name: command.name,
    desired: command.desired,
    logContext: command.logContext,
    ...(command.lifecycleRelease ? { lifecycleRelease: true } : {}),
  };
  if (shouldSkipBinaryControl(deps, controlPlan, decision, snapshot, forceAgainstReleasedOpposing)) {
    return null;
  }
  return decision;
}

function shouldSkipBinaryControl(
  deps: BinaryControlDeps,
  controlPlan: BinaryControlPlan | null,
  /** The requested command, before dispatch preflight. */
  decision: BinaryControlDecision,
  snapshot: BinaryControlDecisionSnapshot | undefined,
  forceAgainstReleasedOpposing: boolean,
): boolean {
  const {
    deviceId, name, desired, logContext,
  } = decision;
  if (!controlPlan) {
    const hasTargets = Array.isArray(snapshot?.targets) && snapshot.targets.length > 0;
    emitExecutorDebug({
      event: 'binary_command_skipped',
      reasonCode: hasTargets ? 'missing_onoff_capability' : 'missing_control_targets',
      deviceId,
      deviceName: name,
      desired,
      logContext,
      hasTargets,
      controlAxis: 'binary',
    });
    return true;
  }
  if (!controlPlan.canSet) {
    emitExecutorDebug({
      event: 'binary_command_skipped',
      reasonCode: 'capability_not_setable',
      deviceId,
      deviceName: name,
      desired,
      controlAxis: 'binary',
      logContext,
    });
    return true;
  }
  if (shouldSkipAlreadyMatched(deps, decision, snapshot, forceAgainstReleasedOpposing)) {
    emitExecutorDebug({
      event: 'binary_command_skipped',
      reasonCode: 'already_matched',
      deviceId,
      deviceName: name,
      desired,
      controlAxis: 'binary',
      logContext,
    });
    return true;
  }
  if (hasPendingMatchingBinaryCommand(deps.pendingBinaryCommandStore, deviceId, desired)) {
    emitExecutorDebug({
      event: 'binary_command_skipped',
      reasonCode: 'already_pending',
      deviceId,
      deviceName: name,
      desired,
      controlAxis: 'binary',
      logContext,
    });
    return true;
  }
  return false;
}

function shouldSkipAlreadyMatched(
  deps: BinaryControlDeps,
  decision: BinaryControlDecision,
  snapshot: BinaryControlDecisionSnapshot | undefined,
  forceAgainstReleasedOpposing: boolean,
): boolean {
  const { deviceId, desired } = decision;
  // A lifecycle release judges against the snapshot it was handed, not the live read.
  const latestObservedSnapshot = decision.lifecycleRelease === true
    ? snapshot
    : deps.getObservedState(deviceId) ?? snapshot;
  // An opposite pending command must be superseded even when the current
  // observation already matches the new intent: the older command may still
  // materialize after this decision.
  if (
    forceAgainstReleasedOpposing
    || hasOppositePendingBinaryCommand(deps.pendingBinaryCommandStore, deviceId, desired)
  ) {
    return false;
  }
  if (!isBinaryControlled(latestObservedSnapshot)) return false;
  return resolveBinaryCommandCurrentOn(latestObservedSnapshot) === desired;
}

function hasOppositePendingBinaryCommand(
  pendingBinaryCommandStore: PendingBinaryCommandStore,
  deviceId: string,
  desired: boolean,
): boolean {
  // `peek` (not `get`): freshness-eviction stays owned by the matching-pending
  // guard below; this read only asks whether an un-superseded opposite intent
  // exists right now.
  const pending = pendingBinaryCommandStore.peek(deviceId);
  if (!pending) return false;
  return pending.desired !== desired;
}

function hasPendingMatchingBinaryCommand(
  pendingBinaryCommandStore: PendingBinaryCommandStore,
  deviceId: string,
  desired: boolean,
): boolean {
  // `get` (not `peek`): this read owns freshness-eviction — a stale
  // in-flight entry must not suppress a fresh actuation. Eviction is
  // performed once, inside the store.
  const pending = pendingBinaryCommandStore.get(deviceId);
  if (!pending) return false;
  return pending.desired === desired;
}

