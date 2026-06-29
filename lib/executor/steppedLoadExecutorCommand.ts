import {
  getSteppedLoadStep,
} from '../utils/deviceControlProfiles';
import type { SteppedLoadStep } from '../../packages/contracts/src/types';
import {
  recordActivationAttemptStarted,
} from '../plan/planExecutorSupport';
import { resolveSteppedLoadCommandPendingMs } from '../plan/planObservationPolicy';
import { isRequestedStepMaterialized } from './steppedLoadActuation';
import type {
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadTransition,
} from './executablePlan';
import type { PlanActuationMode } from './executorTypes';
import {
  PELS_TARGET_STEP_CAPABILITY_ID,
  type SteppedLoadStepRequestTransport,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { getLogger } from '../logging/logger';
import type { PlanExecutorSteppedContext } from './steppedLoadExecutorContext';

const logger = getLogger('executor/stepped-load');

export const isSteppedLoadStepCommandRedundant = (
  action: ExecutableSteppedLoadDevice,
  commandStepId: string,
): boolean => {
  const needsStepPreparation = action.transition?.transitionPhase === 'step_preparation'
    && action.transition.commandStepId === commandStepId;
  const restoreStepNeedsMaterialization = action.transition?.effectiveTransition === 'restore_from_off_at_low'
    && !isRequestedStepMaterialized(action.commandStepActuation);
  return commandStepId === action.current.stepId
    && !needsStepPreparation
    && !restoreStepNeedsMaterialization;
};

export const maybeLogSteppedLoadCommandPendingSkip = (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  mode: PlanActuationMode,
  commandStepId: string,
): boolean => {
  const sameDesiredStepPendingState = action.matchingCommandAttempt;
  if (sameDesiredStepPendingState?.status === 'awaiting_confirmation') {
    logSteppedLoadCommandSkip(ctx, {
      action,
      mode,
      reasonCode: 'waiting_for_confirmation',
      logMessage: `Capacity: skip stepped-load command for ${action.name}, `
        + `awaiting confirmation of ${commandStepId}`,
      fields: { desiredStepId: commandStepId, plannedDesiredStepId: action.desired.plannedStepId ?? null },
    });
    return true;
  }
  if (sameDesiredStepPendingState?.status === 'retry_backoff') {
    logSteppedLoadCommandSkip(ctx, {
      action,
      mode,
      reasonCode: 'retry_backoff',
      logMessage: `Capacity: skip stepped-load command for ${action.name}, `
        + `retry backoff for ${commandStepId} remains active`,
      fields: {
        desiredStepId: commandStepId,
        nextRetryAtMs: action.nextStepCommandRetryAtMs ?? null,
        retryCount: action.stepCommandRetryCount,
      },
    });
    return true;
  }
  return false;
};

export const logSteppedLoadCommandSkip = (
  _ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    mode: PlanActuationMode;
    reasonCode:
      | 'missing_step'
      | 'waiting_for_confirmation'
      | 'retry_backoff'
      | 'command_unavailable';
    logMessage: string;
    fields: Record<string, unknown>;
  },
): false => {
  const { action, mode, reasonCode, logMessage, fields } = params;
  logger.debug({
    event: 'stepped_load_command_skipped',
    reasonCode,
    deviceId: action.id,
    deviceName: action.name,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    logContext: 'capacity',
    actuationMode: mode,
    ...fields,
  });
  logger.debug({ event: 'executor_stepped_log_debug', msg: logMessage });
  return false;
};

export type ExecuteSteppedLoadCommandParams = {
  action: ExecutableSteppedLoadDevice;
  mode: PlanActuationMode;
  options: { recordPlanActuation?: boolean };
  desiredStep: NonNullable<ReturnType<typeof getSteppedLoadStep>>;
  transition: ExecutableSteppedLoadTransition | null;
  previousStepId: string | undefined;
  now: number;
};

type AcceptedSteppedLoadCommandParams = ExecuteSteppedLoadCommandParams & {
  commandTransport?: SteppedLoadStepRequestTransport;
};

const markAcceptedSteppedLoadCommand = (
  ctx: PlanExecutorSteppedContext,
  params: AcceptedSteppedLoadCommandParams,
): void => {
  const {
    action,
    desiredStep,
    previousStepId,
    now,
  } = params;
  ctx.markSteppedLoadDesiredStepIssued({
    deviceId: action.id,
    desiredStepId: desiredStep.id,
    previousStepId,
    issuedAtMs: now,
    pendingWindowMs: resolveSteppedLoadCommandPendingMs(action.communicationModel),
  });
};

const logAcceptedSteppedLoadCommand = (
  _ctx: PlanExecutorSteppedContext,
  params: AcceptedSteppedLoadCommandParams,
): void => {
  const {
    action,
    mode,
    desiredStep,
    transition,
    previousStepId,
    commandTransport,
  } = params;
  const transitionFields = transition ? {
    plannedDesiredStepId: transition.plannedDesiredStepId ?? desiredStep.id,
    commandPurpose: transition.stepPreparationPurpose ? 'step_preparation' : 'step_adjustment',
    stepPreparationPurpose: transition.stepPreparationPurpose ?? null,
    effectiveTransition: transition.effectiveTransition,
    binaryTarget: transition.binaryTarget ?? null,
    transitionPhase: transition.transitionPhase,
  } : {
    plannedDesiredStepId: desiredStep.id,
    commandPurpose: 'step_adjustment',
    stepPreparationPurpose: null,
    effectiveTransition: 'steady',
    binaryTarget: null,
    transitionPhase: 'settled',
  };
  logger.info({
    event: 'stepped_load_command_requested',
    deviceId: action.id,
    deviceName: action.name,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    previousStepId: previousStepId ?? null,
    desiredStepId: desiredStep.id,
    planningPowerW: desiredStep.planningPowerW,
    ...transitionFields,
    ...(commandTransport ? { commandTransport } : {}),
    mode,
  });
};

const recordAcceptedSteppedLoadPlanActuation = (
  ctx: PlanExecutorSteppedContext,
  params: AcceptedSteppedLoadCommandParams,
): void => {
  const {
    action,
    mode,
    options,
    transition,
    now,
  } = params;
  const shouldRecordPlanActuation = options.recordPlanActuation !== false;
  if (mode !== 'plan' || !shouldRecordPlanActuation) return;
  if (transition?.effectiveTransition === 'step_down_while_on') {
    ctx.recordShedActuation(action.id, action.name, now);
    return;
  }
  if (
    transition?.effectiveTransition !== 'step_up_while_on'
    && transition?.effectiveTransition !== 'restore_from_off_at_low'
    && !isSteppedLoadRestoreStepIncrease(action, params.desiredStep.id, params.previousStepId)
  ) return;
  ctx.recordRestoreActuation(action.id, action.name, now);
  recordActivationAttemptStarted({
    state: ctx.state,
    diagnostics: ctx.deviceDiagnostics,
    deviceId: action.id,
    name: action.name,
    nowTs: now,
    source: 'pels_restore',
  });
};

const isSteppedLoadRestoreStepIncrease = (
  action: ExecutableSteppedLoadDevice,
  desiredStepId: string,
  previousStepId: string | undefined,
): boolean => {
  if (action.purpose !== 'keep' || !previousStepId) return false;
  const previousStep = getSteppedLoadStep(action.steppedLoadProfile, previousStepId);
  const desiredStep = getSteppedLoadStep(action.steppedLoadProfile, desiredStepId);
  return Boolean(previousStep && desiredStep && desiredStep.planningPowerW > previousStep.planningPowerW);
};

const recordAcceptedSteppedLoadCommand = (
  ctx: PlanExecutorSteppedContext,
  params: AcceptedSteppedLoadCommandParams,
): boolean => {
  markAcceptedSteppedLoadCommand(ctx, params);
  logAcceptedSteppedLoadCommand(ctx, params);
  recordAcceptedSteppedLoadPlanActuation(ctx, params);
  return true;
};

export const executeSteppedLoadCommand = async (
  ctx: PlanExecutorSteppedContext,
  params: ExecuteSteppedLoadCommandParams,
): Promise<boolean> => {
  const {
    action,
    mode,
    desiredStep,
    previousStepId,
  } = params;
  const planningPowerW = desiredStep.planningPowerW;
  const planningCurrentA = resolvePlanningCurrentA(desiredStep);
  try {
    const result = await ctx.requestSteppedLoadStep({
      deviceId: action.id,
      profile: action.steppedLoadProfile,
      desiredStepId: desiredStep.id,
      planningPowerW,
      planningCurrentA,
      actuationMode: mode,
      previousStepId,
    });
    if (!result.requested) {
      return logSteppedLoadCommandSkip(ctx, {
        action,
        mode,
        reasonCode: 'command_unavailable',
        logMessage: `Capacity: skip stepped-load command for ${action.name}, `
          + `no command transport for desired step ${desiredStep.id}`,
        fields: { desiredStepId: desiredStep.id },
      });
    }
    return recordAcceptedSteppedLoadCommand(ctx, {
      ...params,
      commandTransport: result.transport,
    });
  } catch (error) {
    logger.error({
      event: 'stepped_load_command_failed',
      reasonCode: 'command_failed',
      deviceId: action.id,
      deviceName: action.name,
      desiredStepId: desiredStep.id,
      planningPowerW: desiredStep.planningPowerW,
      mode,
    });
    logger.error({
      event: 'executor_stepped_error',
      msg: `Failed to request stepped-load command for ${action.name}`,
      err: error,
    });
    return false;
  }
};

// The producer (EV target-power profile builder) pre-resolves each step's
// installation current onto `planningCurrentA`; the executor reads it directly
// instead of dividing the step power by the preset's watts-per-amp. Steps from
// capability-built / non-preset profiles carry no `planningCurrentA`, which is
// the same `0` the watts-per-amp path produced for a missing/unknown preset.
const resolvePlanningCurrentA = (
  desiredStep: SteppedLoadStep,
): number => desiredStep.planningCurrentA ?? 0;
