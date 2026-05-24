/* eslint-disable max-lines --
 * Binary-control orchestration keeps shed/restore/EV-deferred branches
 * in one file; the file grew past the 500-line floor after PR #1b
 * absorbed the decision-then-dispatch helper that previously lived in
 * `lib/plan/planBinaryControl.ts`.
 */
import type { DeviceObservation } from '../device/deviceObservation';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import { getLogger } from '../logging/logger';
import {
  canTurnOnDevice,
  recordActivationAttemptStarted,
  recordActivationSetbackForDevice,
  shouldSkipShedding,
} from '../plan/planExecutorSupport';
import {
  formatEvSnapshot,
  getBinaryControlPlan,
  getEvRestoreBlockReason,
  isFlowBackedBinaryControl,
} from '../plan/planBinaryControl';
import {
  type BinaryControlTransport,
  decideAndDispatchBinaryControl,
} from './binaryControlDispatch';
import type { PlanEngineState } from '../plan/planState';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type {
  ExecutableBinaryIntent,
  ExecutableEvIntent,
  ExecutableObservedDeviceState,
} from './executablePlan';
import type { PlanActuationMode } from './executorTypes';

const logger = getLogger('executor/binary');

export type PlanExecutorBinaryContext = {
  state: PlanEngineState;
  observation: DeviceObservation;
  capacityDryRun: boolean;
  buildBinaryControlTransport: () => BinaryControlTransport;
  getRestoreLogSource: (deviceId: string) => 'shed_state' | 'current_plan';
  recordShedActuation: (deviceId: string, name: string, now: number) => void;
  recordRestoreActuation: (deviceId: string, name: string, now: number) => void;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
};

const runBinaryControl = async (params: {
  ctx: PlanExecutorBinaryContext;
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: TargetDeviceSnapshot;
  logContext: 'capacity' | 'capacity_control_off';
  restoreSource?: 'shed_state' | 'current_plan';
  reason?: string;
  actuationMode?: PlanActuationMode;
}): Promise<boolean> => {
  const {
    ctx, deviceId, name, desired, snapshot, logContext, restoreSource, reason, actuationMode,
  } = params;
  return decideAndDispatchBinaryControl({
    state: ctx.state,
    transport: ctx.buildBinaryControlTransport(),
    deviceId,
    name,
    desired,
    snapshot,
    logContext,
    restoreSource,
    reason,
    actuationMode,
  });
};

export const applyBinaryRestore = async (
  ctx: PlanExecutorBinaryContext,
  intent: ExecutableBinaryIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => {
  if (!intent || intent.kind !== 'restore' || intent.source !== 'controlled') return false;
  const snapshot = ctx.observation.getSnapshotByDeviceId(intent.deviceId) ?? observed?.snapshot;
  if (!snapshot) {
    canApplyRestoreSnapshot(ctx, {
      snapshot,
      deviceId: intent.deviceId,
      name: intent.name,
      logContext: 'capacity',
      mode,
    });
    return false;
  }
  if (snapshot.currentOn !== false) return false;
  if (snapshot.deviceClass === 'evcharger') {
    logger.debug({
      event: 'ev_restore_evaluating',
      deviceId: intent.deviceId,
      deviceName: intent.name,
      logContext: 'capacity',
      evSnapshot: formatEvSnapshot(snapshot),
    });
  }
  if (!canApplyRestoreSnapshot(ctx, {
    snapshot,
    deviceId: intent.deviceId,
    name: intent.name,
    logContext: 'capacity',
    mode,
  })) return false;
  return applyBinaryRestoreWithSnapshot(ctx, {
    deviceId: intent.deviceId,
    name: intent.name,
    snapshot: snapshot as TargetDeviceSnapshot,
    logContext: 'capacity',
    mode,
  });
};

export const applyUncontrolledBinaryRestore = async (
  ctx: PlanExecutorBinaryContext,
  intent: ExecutableBinaryIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  if (!intent || intent.kind !== 'restore' || intent.source !== 'uncontrolled') return false;
  const lastShed = ctx.state.lastDeviceShedMs[intent.deviceId];
  if (!lastShed) return false;
  const entry = ctx.observation.getSnapshotByDeviceId(intent.deviceId) ?? observed?.snapshot;
  if (!entry) {
    canApplyRestoreSnapshot(ctx, {
      snapshot: entry,
      deviceId: intent.deviceId,
      name: intent.name,
      logContext: 'capacity_control_off',
      mode: 'plan',
    });
    return false;
  }
  if (entry.currentOn !== false) return false;
  if (entry.deviceClass === 'evcharger') {
    logger.debug({
      event: 'ev_restore_evaluating',
      deviceId: intent.deviceId,
      deviceName: intent.name,
      logContext: 'capacity_control_off',
      evSnapshot: formatEvSnapshot(entry),
    });
  }
  if (!canApplyRestoreSnapshot(ctx, {
    snapshot: entry,
    deviceId: intent.deviceId,
    name: intent.name,
    logContext: 'capacity_control_off',
    mode: 'plan',
  })) return false;
  return applyCapacityControlOffRestoreWithSnapshot(ctx, {
    deviceId: intent.deviceId,
    name: intent.name,
    snapshot: entry as TargetDeviceSnapshot,
  });
};

export const applyBinarySheddingToDevice = async (
  ctx: PlanExecutorBinaryContext,
  params: {
    deviceId: string;
    deviceName: string;
    reason?: string;
    skipPrecheck?: boolean;
    trackPendingShed?: boolean;
  },
): Promise<boolean> => {
  const {
    deviceId,
    deviceName,
    reason,
    skipPrecheck = false,
    trackPendingShed = true,
  } = params;
  if (ctx.capacityDryRun) return false;
  const snapshotState = ctx.observation.getSnapshotByDeviceId(deviceId);
  if (!skipPrecheck && shouldSkipShedding({
    state: ctx.state,
    deviceId,
    deviceName,
    snapshotState,
  })) {
    return false;
  }
  if (!trackPendingShed) {
    return turnOffDevice(ctx, {
      deviceId,
      name: deviceName,
      reason,
      snapshot: snapshotState,
    });
  }
  ctx.state.pendingSheds.add(deviceId);
  try {
    return await turnOffDevice(ctx, {
      deviceId,
      name: deviceName,
      reason,
      snapshot: snapshotState,
    });
  } finally {
    ctx.state.pendingSheds.delete(deviceId);
  }
};

export const applyDeferredEvCommand = async (
  ctx: PlanExecutorBinaryContext,
  intent: ExecutableEvIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => {
  if (!intent) return false;
  const snapshot = ctx.observation.getSnapshotByDeviceId(intent.deviceId) ?? observed?.snapshot;
  if (!snapshot || snapshot.controlCapabilityId !== 'evcharger_charging') return false;

  if (intent.kind === 'ev_pause') {
    if (snapshot.evChargingState !== 'plugged_in_charging') return false;
    return applyBinarySheddingToDevice(ctx, {
      deviceId: intent.deviceId,
      deviceName: intent.name,
    });
  }

  if (snapshot.evChargingState !== 'plugged_in_paused') return false;
  if (!canApplyRestoreSnapshot(ctx, {
    snapshot,
    deviceId: intent.deviceId,
    name: intent.name,
    logContext: 'capacity',
    mode,
  })) return false;
  return applyBinaryRestoreWithSnapshot(ctx, {
    deviceId: intent.deviceId,
    name: intent.name,
    snapshot,
    logContext: 'capacity',
    mode,
  });
};

const canApplyRestoreSnapshot = (
  _ctx: PlanExecutorBinaryContext,
  params: {
    snapshot?: TargetDeviceSnapshot;
    deviceId: string;
    name: string;
    logContext: 'capacity' | 'capacity_control_off';
    mode: PlanActuationMode;
  },
): boolean => {
  const {
    snapshot,
    deviceId,
    name,
    logContext,
    mode,
  } = params;
  if (!snapshot) {
    logger.debug({
      event: 'restore_command_skipped',
      reasonCode: 'missing_snapshot',
      deviceId,
      deviceName: name,
      logContext,
      actuationMode: mode,
    });
    if (logContext === 'capacity') {
      logger.debug({
        event: 'executor_binary_log_debug',
        msg: `Capacity: skip restoring ${name}, no snapshot available`,
      });
    }
    return false;
  }
  if (!canTurnOnDevice(snapshot)) {
    const evReason = getEvRestoreBlockReason(snapshot);
    const suffix = evReason ? ` (${evReason})` : '';
    logger.debug({
      event: 'restore_command_skipped',
      reasonCode: 'not_setable',
      deviceId,
      deviceName: name,
      logContext,
      actuationMode: mode,
    });
    if (logContext === 'capacity') {
      logger.debug({
        event: 'executor_binary_log_debug',
        msg: `Capacity: skip restoring ${name}, cannot turn on from current snapshot${suffix}`,
      });
    }
    return false;
  }
  return true;
};

const applyBinaryRestoreWithSnapshot = async (
  ctx: PlanExecutorBinaryContext,
  params: {
    deviceId: string;
    name: string;
    snapshot: TargetDeviceSnapshot;
    logContext: 'capacity';
    mode: PlanActuationMode;
  },
): Promise<boolean> => {
  const {
    deviceId,
    name,
    snapshot,
    mode,
  } = params;
  if (ctx.state.pendingRestores.has(deviceId)) {
    logger.debug({
      event: 'restore_command_skipped',
      reasonCode: 'already_in_progress',
      deviceId,
      deviceName: name,
      logContext: 'capacity',
      actuationMode: mode,
    });
    logger.debug({ event: 'executor_binary_log_debug', msg: `Capacity: skip restoring ${name}, already in progress` });
    return false;
  }
  ctx.state.pendingRestores.add(deviceId);
  try {
    try {
      const applied = await runBinaryControl({
        ctx,
        deviceId,
        name,
        desired: true,
        snapshot,
        logContext: 'capacity',
        restoreSource: ctx.getRestoreLogSource(deviceId),
        actuationMode: mode,
      });
      if (!applied) return false;
      const flowBackedControl = isFlowBackedBinaryControl(
        snapshot,
        snapshot.controlCapabilityId ?? 'onoff',
      );
      if (!flowBackedControl) {
        logger.info({
          event: 'binary_command_applied',
          deviceId,
          deviceName: name,
          capabilityId: snapshot.controlCapabilityId ?? 'onoff',
          desired: true,
          mode,
          reasonCode: mode === 'reconcile' ? 'reconcile_restore' : ctx.getRestoreLogSource(deviceId),
        });
        recordBinaryRestoreActuation(ctx, { deviceId, name, mode });
        clearPendingSwapTarget(ctx, deviceId);
      }
      return true;
    } catch (error) {
      logger.error({ event: 'executor_binary_error', msg: `Failed to turn on ${name} via DeviceManager`, err: error });
      return false;
    }
  } finally {
    ctx.state.pendingRestores.delete(deviceId);
  }
};

const applyCapacityControlOffRestoreWithSnapshot = async (
  ctx: PlanExecutorBinaryContext,
  params: {
    deviceId: string;
    name: string;
    snapshot: TargetDeviceSnapshot;
  },
): Promise<boolean> => {
  const {
    deviceId,
    name,
    snapshot,
  } = params;
  try {
    const applied = await runBinaryControl({
      ctx,
      deviceId,
      name,
      desired: true,
      snapshot,
      logContext: 'capacity_control_off',
      actuationMode: 'plan',
    });
    if (!applied) return false;
    const flowBackedControl = isFlowBackedBinaryControl(
      snapshot,
      snapshot.controlCapabilityId ?? 'onoff',
    );
    if (!flowBackedControl) {
      logger.info({
        event: 'binary_command_applied',
        deviceId,
        deviceName: name,
        capabilityId: snapshot.controlCapabilityId ?? 'onoff',
        desired: true,
        mode: 'plan',
        reasonCode: 'capacity_control_off_restore',
      });
      // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
      delete ctx.state.lastDeviceShedMs[deviceId];
    }
    return true;
  } catch (error) {
    logger.error({ event: 'executor_binary_error', msg: `Failed to restore ${name} via DeviceManager`, err: error });
    return false;
  }
};

const recordBinaryRestoreActuation = (
  ctx: PlanExecutorBinaryContext,
  params: {
    deviceId: string;
    name: string;
    mode: PlanActuationMode;
  },
): void => {
  const { deviceId, name, mode } = params;
  if (mode === 'plan') {
    const now = Date.now();
    ctx.recordRestoreActuation(deviceId, name, now);
    recordActivationAttemptStarted({
      state: ctx.state,
      diagnostics: ctx.deviceDiagnostics,
      deviceId,
      name,
      nowTs: now,
    });
  } else if (mode === 'reconcile') {
    recordActivationSetbackForDevice({
      state: ctx.state,
      diagnostics: ctx.deviceDiagnostics,
      deviceId,
      name,
      nowTs: Date.now(),
    });
  }
};

const clearPendingSwapTarget = (ctx: PlanExecutorBinaryContext, deviceId: string): void => {
  const swapEntry = ctx.state.swapByDevice[deviceId];
  if (!swapEntry) return;
  // eslint-disable-next-line functional/immutable-data -- Shared executor state update.
  delete swapEntry.pendingTarget;
  // eslint-disable-next-line functional/immutable-data -- Shared executor state update.
  delete swapEntry.timestamp;
  if (!swapEntry.swappedOutFor && swapEntry.lastPlanMeasurementTs === undefined) {
    // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
    delete ctx.state.swapByDevice[deviceId];
  }
};

/* eslint-disable complexity --
 * Binary shed command preserves legacy control capability branches.
 */
const turnOffDevice = async (
  ctx: PlanExecutorBinaryContext,
  params: {
    deviceId: string;
    name: string;
    reason?: string;
    snapshot?: TargetDeviceSnapshot;
  },
): Promise<boolean> => {
  const {
    deviceId,
    name,
    reason,
    snapshot,
  } = params;
  const snapshotEntry = snapshot ?? ctx.observation.getSnapshotByDeviceId(deviceId);
  const controlPlan = getBinaryControlPlan(snapshotEntry);
  if (snapshotEntry?.deviceClass === 'evcharger') {
    logger.debug({
      event: 'ev_shed_preparing',
      deviceName: name,
      evSnapshot: formatEvSnapshot(snapshotEntry),
    });
  }
  if (!controlPlan) {
    const hasTarget = Array.isArray(snapshotEntry?.targets) && snapshotEntry.targets.length > 0;
    const now = Date.now();
    // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
    ctx.state.lastDeviceShedMs[deviceId] = now;
    logger.debug({
      event: 'binary_command_skipped',
      reasonCode: hasTarget ? 'missing_onoff_capability' : 'missing_control_targets',
      deviceId,
      deviceName: name,
      desired: false,
      logContext: 'capacity',
      actuationMode: 'plan',
      hasTargets: hasTarget,
      capabilityId: snapshotEntry?.controlCapabilityId ?? null,
    });
    logger.debug({ event: 'executor_binary_log_debug', msg: hasTarget
      ? `Capacity: skip turn_off for ${name}, device has no onoff capability`
      : `Capacity: skip turn_off for ${name}, device has no onoff or temperature target` });
    return false;
  }
  const now = Date.now();
  try {
    const applied = await runBinaryControl({
      ctx,
      deviceId,
      name,
      desired: false,
      snapshot: snapshotEntry,
      logContext: 'capacity',
      reason,
      actuationMode: 'plan',
    });
    if (!applied) return false;
    const flowBackedControl = isFlowBackedBinaryControl(
      snapshotEntry,
      snapshotEntry?.controlCapabilityId ?? controlPlan.capabilityId,
    );
    if (!flowBackedControl) {
      logger.info({
        event: 'binary_command_applied',
        deviceId,
        deviceName: name,
        capabilityId: snapshotEntry?.controlCapabilityId ?? controlPlan.capabilityId,
        desired: false,
        mode: 'plan',
        reasonCode: reason ? 'shed_with_reason' : 'shedding',
      });
      ctx.recordShedActuation(deviceId, name, now);
    }
    return true;
  } catch (error) {
    logger.error({ event: 'executor_binary_error', msg: `Failed to turn off ${name} via DeviceManager`, err: error });
    return false;
  }
};
/* eslint-enable complexity */
