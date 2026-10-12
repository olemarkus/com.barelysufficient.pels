import { getDebugEmitter, getLogger } from '../logging/logger';
import type { ExecutableTargetCommand } from './executablePlan';
import type { ExecutorCommandContext, PendingTargetCommandStore } from './executorCommandContext';

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
export const readObservedTemperature = (ctx: ExecutorCommandContext, deviceId: string): unknown => (
  ctx.getObservedState(deviceId)?.targets[0]?.value
);

/** `command` carries the value actually requested. */
export const syncPendingTargetCommandAfterActuation = async (
  ctx: ExecutorCommandContext,
  command: ExecutableTargetCommand,
): Promise<TargetCommandPostActuationState> => {
  const { deviceId, name, desired } = command;
  await waitForImmediateObservedState();
  ctx.syncLivePlanStateAfterTargetActuation('realtime_capability');
  const latestObservedValueAfterActuation = readObservedTemperature(ctx, deviceId);
  let pendingStillExists = ctx.targetCommands.pendingTargetCommands[deviceId]?.desired === desired;
  if (pendingStillExists && Object.is(latestObservedValueAfterActuation, desired)) {
    ctx.targetCommands.deletePendingTargetCommand(deviceId);
    pendingStillExists = false;
    ctx.syncLivePlanStateAfterTargetActuation('realtime_capability');
    emitExecutorDebug({
      event: 'executor_target_log_debug',
      msg: `Capacity: confirmed temperature for ${name} at ${desired}°C immediately after actuation`,
    });
  }
  return {
    latestObservedValueAfterActuation,
    pendingStillExists,
  };
};

export const logPendingTargetRetry = (
  name: string,
  pending: PendingTargetCommandStore['pendingTargetCommands'][string],
  retryDelaySec: number,
): void => {
  const { target, desired, retryCount, lastObservedValue, lastObservedSource } = pending;
  logger.info({ event: 'executor_target_log', msg: `Target mismatch still present for ${name}; observed `
    + `${formatObservedTarget(lastObservedValue)} `
    + `via ${lastObservedSource ?? 'unknown'}, retrying ${target} to ${desired}°C` });
  emitExecutorDebug({
    event: 'executor_target_log_debug',
    msg: `Capacity: retried ${target} for ${name} to ${desired}°C `
    + `(retry ${retryCount}, next retry in ${retryDelaySec}s)` });
};

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}
