import { getDebugEmitter, getLogger } from '../logging/logger';
import type { ExecutableTargetCommand } from './executablePlan';
import type { ExecutorCommandContext, PendingTargetCommandStore } from './executorCommandContext';
import { confirmsPendingTargetObservation, formatObservedTarget } from './pendingTargetObservation';

const logger = getLogger('executor/target');
/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

type TargetCommandPostActuationState = {
  latestObservedValueAfterActuation: unknown;
  pendingStillExists: boolean;
};

const waitForImmediateObservedState = async (): Promise<void> => {
  await Promise.resolve();
};

/** The observer's latest reading of the device's primary setpoint. */
export const readObservedTemperatureTarget = (ctx: ExecutorCommandContext, deviceId: string) => (
  ctx.getObservedState(deviceId)?.targets[0]
);

/** `command` carries the value actually requested. */
export const syncPendingTargetCommandAfterActuation = async (
  ctx: ExecutorCommandContext,
  command: ExecutableTargetCommand,
): Promise<TargetCommandPostActuationState> => {
  const { deviceId, name, desired } = command;
  await waitForImmediateObservedState();
  ctx.syncLivePlanStateAfterTargetActuation('realtime_capability');
  const observedTarget = readObservedTemperatureTarget(ctx, deviceId);
  const pending = ctx.targetCommands.pendingTargetCommands[deviceId];
  let pendingStillExists = pending?.desired === desired
    && pending.temperatureBindingGeneration === command.temperatureBindingGeneration;
  if (pending && pendingStillExists && confirmsPendingTargetObservation(pending, observedTarget)) {
    ctx.targetCommands.deletePendingTargetCommand(deviceId);
    pendingStillExists = false;
    ctx.syncLivePlanStateAfterTargetActuation('realtime_capability');
    emitExecutorDebug({
      event: 'executor_target_log_debug',
      msg: `Capacity: confirmed temperature for ${name} at ${desired}°C immediately after actuation`,
    });
  }
  return {
    latestObservedValueAfterActuation: observedTarget?.value,
    pendingStillExists,
  };
};

export const logPendingTargetRetry = (
  name: string,
  pending: PendingTargetCommandStore['pendingTargetCommands'][string],
  retryDelaySec: number,
): void => {
  const { desired, retryCount, lastObservedValue, lastObservedSource } = pending;
  logger.info({ event: 'executor_target_log', msg: `Target mismatch still present for ${name}; observed `
    + `${formatObservedTarget(lastObservedValue)} `
    + `via ${lastObservedSource ?? 'unknown'}, retrying temperature to ${desired}°C` });
  emitExecutorDebug({
    event: 'executor_target_log_debug',
    msg: `Capacity: retried temperature for ${name} to ${desired}°C `
    + `(retry ${retryCount}, next retry in ${retryDelaySec}s)` });
};
