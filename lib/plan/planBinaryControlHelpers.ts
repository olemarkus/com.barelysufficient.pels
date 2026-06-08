import type { DeviceObservation } from '../device/deviceObservation';
import type { BinaryControlCapabilityId, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PendingBinaryCommandStore } from '../observer/pendingBinaryCommands';
import { getObservedBinaryOn } from '../../packages/shared-domain/src/binaryControlState';
import { getLogger } from '../logging/logger';
import type { BinaryControlPlan } from '../device/deviceActionProjection';

const logger = getLogger('plan/binary-helpers');

// `BinaryControlPlan` is owned by the producer
// (`lib/device/deviceActionProjection.ts`) — plan consumes the same flat
// shape it gets back from `getBinaryControlPlan`. Re-exported here for
// plan-internal consumers that already imported it from this module.
export type { BinaryControlPlan };

export type BinaryControlLogContext = 'capacity' | 'capacity_control_off';
export type BinaryControlRestoreSource = 'shed_state' | 'current_plan';
export type BinaryControlActuationMode = 'plan' | 'reconcile';

/**
 * The plan layer hands one of these to the executor per cycle for each
 * device that should actuate. The plan has already recorded the matching
 * `pendingBinaryCommands` entry on the engine state before producing the
 * decision; executor dispatches and, on failure, clears the entry back
 * out via `dispatchBinaryControlDecision`.
 *
 * Keep this struct flat and serializable — it is the structural seam the
 * cruiser rule pins between `lib/plan/` (decision producer) and
 * `lib/executor/` (transport dispatcher).
 */
export type BinaryControlDecision = {
  deviceId: string;
  name: string;
  capabilityId: BinaryControlPlan['capabilityId'];
  desired: boolean;
  flowBackedControl: boolean;
  logContext: BinaryControlLogContext;
  actuationMode: BinaryControlActuationMode;
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
  actuationMode: BinaryControlActuationMode;
  name: string;
  snapshot?: TargetDeviceSnapshot;
  pendingBinaryCommandStore: PendingBinaryCommandStore;
}): boolean {
  const {
    controlPlan,
    deviceManager,
    deviceId,
    desired,
    logContext,
    actuationMode,
    name,
    snapshot,
    pendingBinaryCommandStore,
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
      actuationMode,
      hasTargets,
      capabilityId: snapshot?.controlCapabilityId ?? null,
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
      capabilityId: controlPlan.capabilityId,
      logContext,
      actuationMode,
    });
    return true;
  }
  if (shouldSkipAlreadyMatched({ deviceManager, controlPlan, deviceId, desired, snapshot })) {
    logger.debug({
      event: 'binary_command_skipped',
      reasonCode: 'already_matched',
      deviceId,
      deviceName: name,
      desired,
      capabilityId: controlPlan.capabilityId,
      logContext,
      actuationMode,
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
      capabilityId: controlPlan.capabilityId,
      logContext,
      actuationMode,
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
  snapshot?: TargetDeviceSnapshot;
}): boolean {
  const { deviceManager, controlPlan, deviceId, desired, snapshot } = params;
  // Only skip an already-matched command when the device's observed binary
  // on-state faithfully mirrors its control state. Devices whose observation
  // does not track the on/off control (chargers) report
  // `observedStateComparable === false` and must never short-circuit here.
  if (!controlPlan.observedStateComparable) return false;
  const latestObservedSnapshot = deviceManager.getSnapshotByDeviceId(deviceId) ?? snapshot;
  // A device with no binary control returns `null` here, which never equals the
  // desired boolean — so absent binary state never short-circuits (matches the
  // prior explicit `binaryControl === undefined → return false`).
  return getObservedBinaryOn(latestObservedSnapshot) === desired;
}

export function hasPendingMatchingBinaryCommand(params: {
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  deviceId: string;
  controlPlan: BinaryControlPlan;
  desired: boolean;
}): boolean {
  const { pendingBinaryCommandStore, deviceId, controlPlan, desired } = params;
  // `get` (not `peek`): this read owns freshness-eviction — a stale
  // in-flight entry must not suppress a fresh actuation. Eviction is
  // performed once, inside the store.
  const pending = pendingBinaryCommandStore.get(deviceId);
  if (!pending) return false;
  return pending.capabilityId === controlPlan.capabilityId && pending.desired === desired;
}

export function isFlowBackedBinaryControl(
  snapshot: TargetDeviceSnapshot | undefined,
  capabilityId: BinaryControlCapabilityId,
): boolean {
  return Array.isArray(snapshot?.flowBackedCapabilityIds)
    && snapshot.flowBackedCapabilityIds.includes(capabilityId);
}

export function buildFlowBackedBinaryControlRequestLogMessage(params: {
  logContext: BinaryControlLogContext;
  desired: boolean;
  name: string;
  reason?: string;
  restoreSource?: BinaryControlRestoreSource;
  actuationMode?: BinaryControlActuationMode;
}): string {
  const {
    logContext,
    desired,
    name,
    reason,
    restoreSource = 'current_plan',
    actuationMode = 'plan',
  } = params;
  if (desired) {
    const prefix = logContext === 'capacity_control_off' ? 'Capacity control off' : 'Capacity';
    const suffix = resolveBinaryRestoreSuffix({ logContext, restoreSource, actuationMode });
    return `${prefix}: requested turn on for ${name}${suffix}`;
  }
  if (actuationMode === 'reconcile') {
    return `Capacity: requested turn off for ${name} (reconcile after drift)`;
  }
  if (reason && logContext === 'capacity') {
    return `Capacity: requested turn off for ${name} (${reason})`;
  }
  if (logContext === 'capacity') {
    return `Capacity: requested turn off for ${name} (shedding)`;
  }
  return `Capacity control off: requested turn off for ${name}`;
}

export function resolveBinaryRestoreSuffix(params: {
  logContext: BinaryControlLogContext;
  restoreSource: BinaryControlRestoreSource;
  actuationMode: BinaryControlActuationMode;
}): string {
  const { logContext, restoreSource, actuationMode } = params;
  if (logContext !== 'capacity') return '';
  if (actuationMode === 'reconcile') return ' (reconcile after drift)';
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
  actuationMode?: BinaryControlActuationMode;
}): string {
  const {
    logContext,
    desired,
    name,
    reason,
    restoreSource = 'current_plan',
    actuationMode = 'plan',
  } = params;
  if (desired) {
    const prefix = logContext === 'capacity_control_off' ? 'Capacity control off' : 'Capacity';
    const suffix = resolveBinaryRestoreSuffix({ logContext, restoreSource, actuationMode });
    return `${prefix}: turning on ${name}${suffix}`;
  }
  if (actuationMode === 'reconcile') {
    return `Capacity: turned off ${name} (reconcile after drift)`;
  }
  if (reason && logContext === 'capacity') {
    return `Capacity: turned off ${name} (${reason})`;
  }
  if (logContext === 'capacity') {
    return `Capacity: turned off ${name} (shedding)`;
  }
  return `Capacity control off: turned off ${name}`;
}

// `formatPendingBinaryObservedValue` moved to
// `lib/observer/pendingBinaryCommandFormatting.ts` in PR #4 of the
// observer/transport split. Only `syncPendingBinaryCommands` (also moved to
// observer) consumed it, so plan no longer exports the helper.
