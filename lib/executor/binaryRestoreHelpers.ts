import { canTurnOnDevice } from '../plan/deviceCommandability';
import { getDebugEmitter, getLogger } from '../logging/logger';
import type { ExecutorDeviceSnapshot } from './executablePlan';
import {
  type PlanExecutorBinaryContext,
  runBinaryControl,
  skipRestoreForExternalOffHold,
} from './binaryControlShared';

const logger = getLogger('executor/binary');
/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

export const canApplyRestoreSnapshot = (
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
    emitExecutorDebug({
      event: 'restore_command_skipped',
      reasonCode: 'missing_snapshot',
      deviceId,
      deviceName: name,
      logContext,
    });
    if (logContext === 'capacity') {
      emitExecutorDebug({
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
    emitExecutorDebug({
      event: 'restore_command_skipped',
      reasonCode: 'not_setable',
      deviceId,
      deviceName: name,
      logContext,
    });
    if (logContext === 'capacity') {
      emitExecutorDebug({
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
  deviceId: string,
  name: string,
  snapshot: ExecutorDeviceSnapshot,
): Promise<boolean> => {
  // "Leave off until turned on again", at the FUNNEL: every controlled-restore
  // lane ends here — the plan lane, and the smart-task deferred `binary_restore`
  // — so one guard covers them all and they cannot drift apart. See
  // `skipRestoreForExternalOffHold`.
  if (skipRestoreForExternalOffHold(ctx, deviceId, name)) return false;
  if (ctx.state.actuation.isRestoreInFlight(deviceId)) {
    emitExecutorDebug({
      event: 'restore_command_skipped',
      reasonCode: 'already_in_progress',
      deviceId,
      deviceName: name,
      logContext: 'capacity',
    });
    emitExecutorDebug({
      event: 'executor_binary_log_debug',
      msg: `Capacity: skip restoring ${name}, already in progress`,
    });
    return false;
  }
  ctx.state.actuation.beginRestore(deviceId);
  try {
    try {
      const outcome = await runBinaryControl({
        ctx,
        deviceId,
        name,
        desired: true,
        snapshot,
        logContext: 'capacity',
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
    ctx.state.actuation.endRestore(deviceId);
  }
};
