import type { DeviceObservation } from '../device/deviceObservation';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PlanEngineState } from './planState';
import { isPendingBinaryCommandActive } from './planObservationPolicy';
import { getLogger } from '../logging/logger';
import type { BinaryControlPlan } from '../device/deviceActionProjection';

const logger = getLogger('plan/binary-helpers');

// `BinaryControlPlan` is owned by the producer
// (`lib/device/deviceActionProjection.ts`) — plan consumes the same flat
// shape it gets back from `getBinaryControlPlan`. Re-exported here for
// plan-internal consumers that already imported it from this module.
export type { BinaryControlPlan };

export type BinaryControlLogContext = 'capacity' | 'capacity_control_off' | 'release';
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
  isEv: boolean;
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
  state: PlanEngineState;
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
    state,
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
  if (hasPendingMatchingBinaryCommand({ state, deviceId, controlPlan, desired })) {
    // Codex review of #1249: when an in-flight `release` pending entry would
    // otherwise satisfy a fresh capacity shed for the same device, promote
    // the pending's logContext so `handleConfirmedBinaryCommand` records
    // the cap-shed markers (lastInstabilityMs / lastDeviceShedMs) when the
    // off-write confirms. Without this, the capacity shed silently rides
    // the release entry's diagnostic-only recorder and the cooldown clock
    // never advances. Promotion is one-way (release → capacity); reverse
    // direction stays as-is since capacity cooldown semantics are stronger.
    const pending = getPendingBinaryCommand(state, deviceId);
    if (pending && pending.logContext === 'release' && logContext === 'capacity') {
      pending.logContext = 'capacity';
    }
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
  if (controlPlan.isEv) return false;
  const latestObservedSnapshot = deviceManager.getSnapshotByDeviceId(deviceId) ?? snapshot;
  if (typeof latestObservedSnapshot?.currentOn !== 'boolean') return false;
  return latestObservedSnapshot.currentOn === desired;
}

export function hasPendingMatchingBinaryCommand(params: {
  state: PlanEngineState;
  deviceId: string;
  controlPlan: BinaryControlPlan;
  desired: boolean;
}): boolean {
  const { state, deviceId, controlPlan, desired } = params;
  const pending = getPendingBinaryCommand(state, deviceId);
  if (!pending) return false;
  return pending.capabilityId === controlPlan.capabilityId && pending.desired === desired;
}

export function getPendingBinaryCommand(
  state: PlanEngineState,
  deviceId: string,
): PlanEngineState['pendingBinaryCommands'][string] | undefined {
  const pendingBinaryCommands = state.pendingBinaryCommands;
  const entry = pendingBinaryCommands[deviceId];
  if (!entry) return undefined;
  if (isPendingBinaryCommandActive({ pending: entry })) {
    return entry;
  }
  delete pendingBinaryCommands[deviceId];
  return undefined;
}

export function formatEvSnapshot(snapshot?: TargetDeviceSnapshot): string {
  if (!snapshot) return 'snapshot=missing';
  return [
    `currentOn=${String(snapshot.currentOn)}`,
    `evState=${snapshot.evChargingState ?? 'unknown'}`,
    `available=${snapshot.available !== false}`,
    `canSet=${snapshot.canSetControl !== false}`,
    `powerKw=${snapshot.powerKw ?? snapshot.measuredPowerKw ?? snapshot.expectedPowerKw ?? 'unknown'}`,
    `expectedPowerKw=${snapshot.expectedPowerKw ?? 'unknown'}`,
  ].join(', ');
}

export function isFlowBackedBinaryControl(
  snapshot: TargetDeviceSnapshot | undefined,
  capabilityId: 'onoff' | 'evcharger_charging',
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

export function buildFlowBackedEvBinaryControlRequestLogMessage(
  logContext: BinaryControlLogContext,
  desired: boolean,
  name: string,
  reason?: string,
  actuationMode: BinaryControlActuationMode = 'plan',
): string {
  const prefix = logContext === 'capacity_control_off' ? 'Capacity control off' : 'Capacity';
  if (actuationMode === 'reconcile') {
    const actionText = desired ? 'requested charging resume for' : 'requested charging pause for';
    return `${prefix}: ${actionText} ${name} (reconcile after drift)`;
  }
  const actionText = desired ? 'requested charging resume for' : 'requested charging pause for';
  const suffix = !desired && reason ? ` (${reason})` : '';
  return `${prefix}: ${actionText} ${name}${suffix}`;
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

export function buildEvBinaryControlLogMessage(
  logContext: BinaryControlLogContext,
  desired: boolean,
  name: string,
  reason?: string,
  actuationMode: BinaryControlActuationMode = 'plan',
): string {
  const prefix = logContext === 'capacity_control_off' ? 'Capacity control off' : 'Capacity';
  if (actuationMode === 'reconcile') {
    const actionText = desired ? 'resumed charging for' : 'paused charging for';
    return `${prefix}: ${actionText} ${name} (reconcile after drift)`;
  }
  const actionText = desired ? 'resumed charging for' : 'paused charging for';
  const suffix = !desired && reason ? ` (${reason})` : '';
  return `${prefix}: ${actionText} ${name}${suffix}`;
}

// `formatPendingBinaryObservedValue` moved to
// `lib/observer/pendingBinaryCommandFormatting.ts` in PR #4 of the
// observer/transport split. Only `syncPendingBinaryCommands` (also moved to
// observer) consumed it, so plan no longer exports the helper.
