import {
  canTurnOnDevice,
  recordActivationAttemptStarted,
} from '../plan/planExecutorSupport';
import {
  getEvRestoreBlockReason,
} from '../plan/planBinaryControl';
import { getLogger } from '../logging/logger';
import type { ExecutorDeviceSnapshot } from './executablePlan';
import {
  type PlanExecutorBinaryContext,
  runBinaryControl,
  skipRestoreForExternalOffHold,
  skipRestoreForSurplusPosture,
} from './binaryControlShared';

const logger = getLogger('executor/binary');

export const canApplyRestoreSnapshot = (
  _ctx: PlanExecutorBinaryContext,
  params: {
    snapshot?: ExecutorDeviceSnapshot;
    deviceId: string;
    name: string;
    logContext: 'capacity' | 'capacity_control_off';
  },
): boolean => {
  const {
    snapshot,
    deviceId,
    name,
    logContext,
  } = params;
  if (!snapshot) {
    logger.debug({
      event: 'restore_command_skipped',
      reasonCode: 'missing_snapshot',
      deviceId,
      deviceName: name,
      logContext,
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
    snapshot: ExecutorDeviceSnapshot;
    logContext: 'capacity';
  },
): Promise<boolean> => {
  const {
    deviceId,
    name,
    snapshot,
  } = params;
  // "Leave off until turned on again", at the FUNNEL: every controlled-restore
  // lane ends here — the plan lane, and the smart-task deferred `binary_restore`
  // — so one guard covers them all and they cannot drift apart. Placed like
  // `skipRestoreForSurplusPosture` in the capacity-control-off helper for the
  // same reason. See `skipRestoreForExternalOffHold`.
  if (skipRestoreForExternalOffHold(ctx, deviceId, name)) return false;
  if (ctx.state.pendingRestores.has(deviceId)) {
    logger.debug({
      event: 'restore_command_skipped',
      reasonCode: 'already_in_progress',
      deviceId,
      deviceName: name,
      logContext: 'capacity',
    });
    logger.debug({ event: 'executor_binary_log_debug', msg: `Capacity: skip restoring ${name}, already in progress` });
    return false;
  }
  ctx.state.pendingRestores.add(deviceId);
  try {
    try {
      const outcome = await runBinaryControl({
        ctx,
        deviceId,
        name,
        desired: true,
        snapshot,
        logContext: 'capacity',
        restoreSource: ctx.getRestoreLogSource(deviceId),
      });
      if (!outcome.applied) return false;
      if (!outcome.flowBacked) {
        logger.info({
          event: 'binary_command_applied',
          deviceId,
          deviceName: name,
          capabilityId: snapshot.controlCapabilityId ?? 'onoff',
          desired: true,
          reasonCode: ctx.getRestoreLogSource(deviceId),
        });
        recordBinaryRestoreActuation(ctx, { deviceId, name });
        ctx.state.clearPendingSwapTarget(deviceId);
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
    snapshot: ExecutorDeviceSnapshot;
  },
): Promise<boolean> => {
  const {
    deviceId,
    name,
    snapshot,
  } = params;
  // "Run on solar surplus" carve-out, last line of defense — whatever lane
  // reaches this helper, the shared guard skips force-turning-ON a baseline-off
  // dump load on capacity-control-off/unmanage. See `skipRestoreForSurplusPosture`.
  if (skipRestoreForSurplusPosture(ctx, deviceId, name)) return false;
  // "Leave off until turned on again" reaches this lane too. A device that still
  // carries `shedDecidedMs` from an earlier capacity shed, is then turned off
  // outside PELS, and is then unmanaged (or has Power-limit control switched off)
  // would otherwise be force-turned-ON here — the one thing the hold forbids.
  // Losing control authority is not consent to undo the user's own off action.
  if (skipRestoreForExternalOffHold(ctx, deviceId, name)) return false;
  try {
    const outcome = await runBinaryControl({
      ctx,
      deviceId,
      name,
      desired: true,
      snapshot,
      logContext: 'capacity_control_off',
    });
    if (!outcome.applied) return false;
    if (!outcome.flowBacked) {
      logger.info({
        event: 'binary_command_applied',
        deviceId,
        deviceName: name,
        capabilityId: snapshot.controlCapabilityId ?? 'onoff',
        desired: true,
        reasonCode: 'capacity_control_off_restore',
      });
      ctx.state.clearDeviceShed(deviceId);
      ctx.state.clearShedDecision(deviceId);
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
  },
): void => {
  const { deviceId, name } = params;
  // Unconditional: every restore actuation stamps the 60-300 s restore cooldown
  // and opens an activation attempt. Only `mode === 'plan'` used to, so a
  // reconcile-driven restore armed no cooldown at all — the other half of how a
  // re-assert could outrun the planner in inc_26449fb9.
  const now = Date.now();
  ctx.recordRestoreActuation(deviceId, name, now);
  recordActivationAttemptStarted({
    state: ctx.state,
    diagnostics: ctx.deviceDiagnostics,
    deviceId,
    name,
    nowTs: now,
  });
};
