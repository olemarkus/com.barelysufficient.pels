import {
  canTurnOnDevice,
} from '../plan/planExecutorSupport';
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
    // Same wording the owner sees on the device card: both come from
    // `resolveCommandabilityDetail` over the same observed facts.
    const suffix = ' (observer reports the control unavailable)';
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
    return true;
  } catch (error) {
    logger.error({ event: 'executor_binary_error', msg: `Failed to restore ${name} via DeviceTransport`, err: error });
    return false;
  }
};
