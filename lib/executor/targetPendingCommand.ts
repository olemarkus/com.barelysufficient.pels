import type { PendingTargetObservationSource } from '../plan/planTypes';
import { getDebugEmitter, getLogger } from '../logging/logger';
import type { PlanExecutorTargetContext } from './targetExecutorContext';

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

export const syncPendingTargetCommandAfterActuation = async (
  ctx: PlanExecutorTargetContext,
  params: {
    deviceId: string;
    name: string;
    target: 'temperature';
    desired: number;
  },
): Promise<TargetCommandPostActuationState> => {
  const { deviceId, name, target, desired } = params;
  await waitForImmediateObservedState();
  ctx.syncLivePlanStateAfterTargetActuation?.('realtime_capability');
  const latestObservedValueAfterActuation = ctx.getObservedTemperatureValue(deviceId);
  let pendingStillExists = hasMatchingPendingTargetCommand(ctx, deviceId, desired);
  if (pendingStillExists && Object.is(latestObservedValueAfterActuation, desired)) {
    ctx.state.deletePendingTargetCommand(deviceId);
    pendingStillExists = false;
    ctx.syncLivePlanStateAfterTargetActuation?.('realtime_capability');
    emitExecutorDebug({
      event: 'executor_target_log_debug',
      msg: `Capacity: confirmed ${target} for ${name} at ${desired}°C immediately after actuation`,
    });
  }
  return {
    latestObservedValueAfterActuation,
    pendingStillExists,
  };
};

const hasMatchingPendingTargetCommand = (
  ctx: PlanExecutorTargetContext,
  deviceId: string,
  desired: number,
): boolean => ctx.state.pendingTargetCommands[deviceId]?.target === 'temperature'
  && ctx.state.pendingTargetCommands[deviceId]?.desired === desired;

export const logPendingTargetRetry = async (
  ctx: PlanExecutorTargetContext,
  params: {
    deviceId: string;
    name: string;
    target: 'temperature';
    desired: number;
    retryCount: number;
    retryDelaySec: number;
    observedValue?: unknown;
    observedSource?: PendingTargetObservationSource;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  },
): Promise<void> => {
  const {
    deviceId,
    name,
    target,
    desired,
    retryCount,
    retryDelaySec,
    observedValue,
    observedSource,
    skipContext,
  } = params;
  logger.info({ event: 'executor_target_log', msg: `Target mismatch still present for ${name}; observed `
    + `${formatObservedTarget(observedValue)} `
    + `via ${observedSource ?? 'unknown'}, retrying ${target} to ${desired}°C` });
  emitExecutorDebug({
    event: 'executor_target_log_debug',
    msg: `Capacity: retried ${target} for ${name} to ${desired}°C `
    + `(retry ${retryCount}, next retry in ${retryDelaySec}s)` });
  try {
    await ctx.logTargetRetryComparison?.({
      deviceId,
      name,
      target,
      desired,
      observedValue,
      observedSource,
      retryCount,
      skipContext,
    });
  } catch (error) {
    logger.error({
      event: 'executor_target_error',
      msg: `Failed to log target retry comparison for ${name}`,
      err: error,
    });
  }
};

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}
