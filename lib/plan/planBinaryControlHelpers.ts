import type { DeviceObservation } from '../device/deviceObservation';
import type { DeviceDescriptor, ObservedDeviceState } from '../../packages/contracts/src/types';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import {
  isBinaryControlled,
  resolveBinaryCommandCurrentOn,
} from '../../packages/shared-domain/src/binaryControlState';
import { getLogger } from '../logging/logger';
import type { BinaryControlPlan } from '../device/deviceActionProjection';

const logger = getLogger('plan/binary-helpers');

/**
 * The decomposed snapshot surface the binary-control decision reads: observed
 * truth (`targets`/`binaryControl`) plus the descriptor config the skip/route
 * gates consult. Narrower than the raw producer `TargetDeviceSnapshot` — the
 * full snapshot remains assignable, so callers pass it unchanged.
 */
export type BinaryControlDecisionSnapshot = Pick<ObservedDeviceState, 'targets' | 'binaryControl'>
  & Pick<
    DeviceDescriptor,
    'capabilities' | 'canSetControl' | 'communicationModel'
  > & { currentOn?: boolean };

// `BinaryControlPlan` is owned by the producer
// (`lib/device/deviceActionProjection.ts`) — plan consumes the same flat
// shape it gets back from `getBinaryControlPlan`. Re-exported here for
// plan-internal consumers that already imported it from this module.
export type { BinaryControlPlan };

export type BinaryControlLogContext = 'capacity' | 'capacity_control_off';
export type BinaryControlRestoreSource = 'shed_state' | 'current_plan';

/**
 * The plan layer hands one of these to the executor per cycle for each
 * device that should actuate. The executor records provisional pending state
 * before dispatch, accepts it only after transport success and a live authority
 * check, and clears it when dispatch cannot proceed.
 *
 * Keep this struct flat and serializable — it is the structural seam the
 * cruiser rule pins between `lib/plan/` (decision producer) and
 * `lib/executor/` (transport dispatcher).
 */
export type BinaryControlDecision = {
  deviceId: string;
  name: string;
  desired: boolean;
  logContext: BinaryControlLogContext;
  restoreSource?: BinaryControlRestoreSource;
  reason?: string;
  /**
   * True when this decision comes from the smart-task lifecycle-end disable path
   * rather than a capacity shed. Carried onto the pending entry so the executor's
   * direct and deferred (flow-backed) confirmation paths both record via the
   * diagnostic-only release recorder and never stamp the capacity cooldown markers.
   */
  lifecycleRelease?: boolean;
};

export function shouldSkipBinaryControl(params: {
  controlPlan: BinaryControlPlan | null;
  deviceManager: DeviceObservation;
  deviceId: string;
  desired: boolean;
  logContext: BinaryControlLogContext;
  name: string;
  snapshot?: BinaryControlDecisionSnapshot;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  preferProvidedSnapshot?: boolean;
  forceAgainstReleasedOpposing?: boolean;
}): boolean {
  const {
    controlPlan,
    deviceManager,
    deviceId,
    desired,
    logContext,
    name,
    snapshot,
    pendingBinaryCommandStore,
    preferProvidedSnapshot,
    forceAgainstReleasedOpposing,
  } = params;
  if (!controlPlan) {
    const hasTargets = Array.isArray(snapshot?.targets) && snapshot.targets.length > 0;
    logger.debug({
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
    logger.debug({
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
  if (shouldSkipAlreadyMatched({
    deviceManager, controlPlan, deviceId, desired, snapshot, pendingBinaryCommandStore,
    preferProvidedSnapshot,
    forceAgainstReleasedOpposing,
  })) {
    logger.debug({
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
  if (hasPendingMatchingBinaryCommand({ pendingBinaryCommandStore, deviceId, controlPlan, desired })) {
    logger.debug({
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

export function shouldSkipAlreadyMatched(params: {
  deviceManager: DeviceObservation;
  controlPlan: BinaryControlPlan;
  deviceId: string;
  desired: boolean;
  snapshot?: BinaryControlDecisionSnapshot;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  preferProvidedSnapshot?: boolean;
  forceAgainstReleasedOpposing?: boolean;
}): boolean {
  const {
    deviceManager, controlPlan, deviceId, desired, snapshot, pendingBinaryCommandStore,
    preferProvidedSnapshot,
    forceAgainstReleasedOpposing,
  } = params;
  const latestObservedSnapshot = preferProvidedSnapshot
    ? snapshot
    : deviceManager.getSnapshotByDeviceId(deviceId) ?? snapshot;
  // An opposite pending command must be superseded even when the current
  // observation already matches the new intent: the older command may still
  // materialize after this decision.
  if (
    forceAgainstReleasedOpposing === true
    || hasOppositePendingBinaryCommand({ pendingBinaryCommandStore, deviceId, controlPlan, desired })
  ) {
    return false;
  }
  if (!isBinaryControlled(latestObservedSnapshot)) return false;
  return resolveBinaryCommandCurrentOn(latestObservedSnapshot) === desired;
}

function hasOppositePendingBinaryCommand(params: {
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  deviceId: string;
  controlPlan: BinaryControlPlan;
  desired: boolean;
}): boolean {
  const { pendingBinaryCommandStore, deviceId, desired } = params;
  // `peek` (not `get`): freshness-eviction stays owned by the matching-pending
  // guard below; this read only asks whether an un-superseded opposite intent
  // exists right now.
  const pending = pendingBinaryCommandStore.peek(deviceId);
  if (!pending) return false;
  return pending.desired !== desired;
}

export function hasPendingMatchingBinaryCommand(params: {
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  deviceId: string;
  controlPlan: BinaryControlPlan;
  desired: boolean;
}): boolean {
  const { pendingBinaryCommandStore, deviceId, desired } = params;
  // `get` (not `peek`): this read owns freshness-eviction — a stale
  // in-flight entry must not suppress a fresh actuation. Eviction is
  // performed once, inside the store.
  const pending = pendingBinaryCommandStore.get(deviceId);
  if (!pending) return false;
  return pending.desired === desired;
}

export function resolveBinaryRestoreSuffix(params: {
  logContext: BinaryControlLogContext;
  restoreSource: BinaryControlRestoreSource;
}): string {
  const { logContext, restoreSource } = params;
  if (logContext !== 'capacity') return '';
  return restoreSource === 'shed_state'
    ? ' (restored from shed state)'
    : ' (to match current plan)';
}

export function buildBinaryControlLogMessage(params: {
  logContext: BinaryControlLogContext;
  desired: boolean;
  name: string;
  reason?: string;
  restoreSource?: BinaryControlRestoreSource;
}): string {
  const {
    logContext,
    desired,
    name,
    reason,
    restoreSource = 'current_plan',
  } = params;
  if (desired) {
    const prefix = logContext === 'capacity_control_off' ? 'Capacity control off' : 'Capacity';
    const suffix = resolveBinaryRestoreSuffix({ logContext, restoreSource });
    return `${prefix}: turning on ${name}${suffix}`;
  }
  if (reason && logContext === 'capacity') {
    return `Capacity: turned off ${name} (${reason})`;
  }
  if (logContext === 'capacity') {
    return `Capacity: turned off ${name} (shedding)`;
  }
  return `Capacity control off: turned off ${name}`;
}
