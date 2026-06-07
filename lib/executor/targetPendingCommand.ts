import type { PendingTargetObservationSource } from '../plan/planTypes';
import { getLogger } from '../logging/logger';
import type { PlanExecutorTargetContext } from './targetExecutorContext';

const logger = getLogger('executor/target');

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
    targetCap: string;
    desired: number;
  },
): Promise<TargetCommandPostActuationState> => {
  const { deviceId, name, targetCap, desired } = params;
  await waitForImmediateObservedState();
  ctx.syncLivePlanStateAfterTargetActuation?.('realtime_capability');
  const latestObservedValueAfterActuation = getLatestObservedTargetValue(ctx, deviceId, targetCap);
  let pendingStillExists = hasMatchingPendingTargetCommand(ctx, deviceId, targetCap, desired);
  if (pendingStillExists && Object.is(latestObservedValueAfterActuation, desired)) {
    // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
    delete ctx.state.pendingTargetCommands[deviceId];
    pendingStillExists = false;
    ctx.syncLivePlanStateAfterTargetActuation?.('realtime_capability');
    logger.debug({
      event: 'executor_target_log_debug',
      msg: `Capacity: confirmed ${targetCap} for ${name} at ${desired}°C immediately after actuation`,
    });
  }
  return {
    latestObservedValueAfterActuation,
    pendingStillExists,
  };
};

const getLatestObservedTargetValue = (
  ctx: PlanExecutorTargetContext,
  deviceId: string,
  targetCap: string,
): unknown => ctx.getObservedState(deviceId)
  ?.targets?.find((entry) => entry.id === targetCap)
  ?.value;

const hasMatchingPendingTargetCommand = (
  ctx: PlanExecutorTargetContext,
  deviceId: string,
  targetCap: string,
  desired: number,
): boolean => ctx.state.pendingTargetCommands[deviceId]?.capabilityId === targetCap
    && ctx.state.pendingTargetCommands[deviceId]?.desired === desired;

export const logPendingTargetRetry = async (
  ctx: PlanExecutorTargetContext,
  params: {
    deviceId: string;
    name: string;
    targetCap: string;
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
    targetCap,
    desired,
    retryCount,
    retryDelaySec,
    observedValue,
    observedSource,
    skipContext,
  } = params;
  logger.info({ event: 'executor_target_log', msg: `Target mismatch still present for ${name}; observed `
    + `${formatObservedTarget(observedValue)} `
    + `via ${observedSource ?? 'unknown'}, retrying ${targetCap} to ${desired}°C` });
  logger.debug({ event: 'executor_target_log_debug', msg: `Capacity: retried ${targetCap} for ${name} to ${desired}°C `
    + `(retry ${retryCount}, next retry in ${retryDelaySec}s)` });
  try {
    await ctx.logTargetRetryComparison?.({
      deviceId,
      name,
      targetCap,
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
