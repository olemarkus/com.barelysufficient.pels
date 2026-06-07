import {
  canTurnOnDevice,
  recordActivationAttemptStarted,
  recordActivationSetbackForDevice,
} from '../plan/planExecutorSupport';
import {
  getEvRestoreBlockReason,
  isFlowBackedBinaryControl,
} from '../plan/planBinaryControl';
import { getLogger } from '../logging/logger';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PlanActuationMode } from './executorTypes';
import { type PlanExecutorBinaryContext, runBinaryControl } from './binaryControlShared';

const logger = getLogger('executor/binary');

export const canApplyRestoreSnapshot = (
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

export const applyBinaryRestoreWithSnapshot = async (
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
      logger.error({
        event: 'executor_binary_error',
        msg: `Failed to turn on ${name} via DeviceTransport`,
        err: error,
      });
      return false;
    }
  } finally {
    ctx.state.pendingRestores.delete(deviceId);
  }
};

export const applyCapacityControlOffRestoreWithSnapshot = async (
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
      // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
      delete ctx.state.shedDecidedMs[deviceId];
    }
    return true;
  } catch (error) {
    logger.error({ event: 'executor_binary_error', msg: `Failed to restore ${name} via DeviceTransport`, err: error });
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
