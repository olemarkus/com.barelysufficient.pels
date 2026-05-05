/* eslint-disable max-lines --
 * Extracted stepped-load actuation remains one cohesive invariant-heavy
 * pipeline after the executor split.
 */
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
} from '../utils/deviceControlProfiles';
import type { SteppedLoadProfile, TargetDeviceSnapshot } from '../utils/types';
import {
  canTurnOnDevice,
  recordActivationAttemptStarted,
  recordActivationSetbackForDevice,
} from '../plan/planExecutorSupport';
import { setBinaryControl } from '../plan/planBinaryControl';
import { resolveSteppedLoadCommandPendingMs } from '../plan/planObservationPolicy';
import {
  isRequestedStepMaterialized,
  type SteppedStepActuationState,
} from './steppedLoadActuation';
import type { ExecutableSteppedLoadDevice, ExecutableSteppedLoadTransition } from './executablePlan';
import {
  isNativeSteppedLoadControlEnabled,
} from '../core/nativeSteppedLoadWiring';
import type { PlanActuationMode } from './executorTypes';
import type { PlanEngineState } from '../plan/planState';
import type { DeviceManager } from '../core/deviceManager';
import { PELS_TARGET_STEP_CAPABILITY_ID } from '../core/steppedLoadSyntheticCapabilities';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import {
  allowsSteppedLoadKeepInvariantRestore,
  isRestoreAdmissionHoldReason,
  isShedWindowHoldReason,
} from '../planContract/planDecisionSemantics';
import type { PlanReasonCode } from '../../packages/shared-domain/src/planReasonSemantics';

const isShedSteppedNonExecutableHoldForSnapshot = (
  action: ExecutableSteppedLoadDevice,
  snapshot?: TargetDeviceSnapshot,
): boolean => (
  action.plannedState === 'shed'
  && (
    isRestoreAdmissionHoldReason(action.reason)
    || (isShedWindowHoldReason(action.reason)
      && (snapshot?.currentOn ?? action.effectiveCurrentOn) === false)
  )
);

export type PlanExecutorSteppedContext = {
  state: PlanEngineState;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  structuredLog?: {
    info: (obj: object) => void;
    error: (obj: object) => void;
  };
  debugStructured?: StructuredDebugEmitter;
  buildBinaryControlDeps: () => {
    state: PlanEngineState;
    deviceManager: DeviceManager;
    log: (...args: unknown[]) => void;
    logDebug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    structuredLog?: PinoLogger;
    debugStructured?: StructuredDebugEmitter;
  };
  setNativeSteppedLoadStep: (
    deviceId: string,
    profile: SteppedLoadProfile,
    desiredStepId: string,
  ) => Promise<boolean>;
  markSteppedLoadDesiredStepIssued: (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
    pendingWindowMs?: number;
  }) => void;
  recordShedActuation: (deviceId: string, name: string, now: number) => void;
  recordRestoreActuation: (deviceId: string, name: string, now: number) => void;
  getRestoreLogSource: (deviceId: string) => 'shed_state' | 'current_plan';
  getDesiredSteppedLoadTrigger: () => {
    trigger: (tokens?: object, state?: object) => Promise<unknown>;
  } | undefined;
  deviceDiagnostics?: DeviceDiagnosticsRecorder;
};

/* eslint-disable complexity --
 * Command dispatch still combines step validation, retry gating, and
 * restore/shed transitions in one path.
 */
export const applySteppedLoadCommand = async (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  mode: PlanActuationMode,
  snapshot?: TargetDeviceSnapshot,
  options: { recordPlanActuation?: boolean } = {},
): Promise<boolean> => {
  if (isShedSteppedNonExecutableHoldForSnapshot(action, snapshot)) return false;
  const profile = action.steppedLoadProfile;
  const commandStepId = action.commandStepId;
  const needsStepPreparation = action.transition?.transitionPhase === 'step_preparation'
    && action.transition.commandStepId === commandStepId;
  const restoreStepNeedsMaterialization = action.transition?.effectiveTransition === 'restore_from_off_at_low'
    && !isRequestedStepMaterialized(action.commandStepActuation);
  if (!commandStepId) return false;
  if (
    commandStepId === action.currentStepId
    && !needsStepPreparation
    && !restoreStepNeedsMaterialization
  ) return false;
  const desiredStep = getSteppedLoadStep(profile, commandStepId);
  if (!desiredStep) {
    return logSteppedLoadCommandSkip(ctx, {
      action,
      mode,
      reasonCode: 'missing_step',
      logMessage: `Capacity: skip stepped-load command for ${action.name}, `
        + `desired step ${commandStepId} is not in profile`,
      fields: { desiredStepId: commandStepId, plannedDesiredStepId: action.requestedStepId ?? null },
    });
  }
  if (action.plannedState === 'shed') {
    const selectedPowerW = action.currentStepForShed?.planningPowerW ?? 0;
    if (desiredStep.planningPowerW > selectedPowerW) {
      return logSteppedLoadCommandSkip(ctx, {
        action,
        mode,
        reasonCode: 'step_up_blocked',
        logMessage: `Capacity: skip step command for ${action.name}, shed device has upward`
          + ` desiredStepId=${commandStepId} vs currentStepId=${action.currentStepForShed?.stepId ?? 'unknown'}`
          + ` (power ${selectedPowerW}W)`,
        fields: { desiredStepId: commandStepId, currentStepId: action.currentStepForShed?.stepId ?? null },
      });
    }
  }
  const now = Date.now();
  const previousStepId = action.previousStepId;
  const sameDesiredStepPendingState = action.matchingCommandAttempt;
  if (sameDesiredStepPendingState?.status === 'awaiting_confirmation') {
    return logSteppedLoadCommandSkip(ctx, {
      action,
      mode,
      reasonCode: 'waiting_for_confirmation',
      logMessage: `Capacity: skip stepped-load command for ${action.name}, `
        + `awaiting confirmation of ${commandStepId}`,
      fields: { desiredStepId: commandStepId, plannedDesiredStepId: action.requestedStepId ?? null },
    });
  }
  if (sameDesiredStepPendingState?.status === 'retry_backoff') {
    return logSteppedLoadCommandSkip(ctx, {
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
  }
  return executeSteppedLoadCommand(ctx, {
    action,
    mode,
    options,
    desiredStep,
    transition: action.transition,
    previousStepId,
    now,
  });
};
/* eslint-enable complexity */

const logSteppedLoadStepViolation = (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  name: string,
  desiredStepId?: string,
): void => {
  const stepDetail = action.currentStepIsOffStep
    ? `${action.currentStepForShed?.stepId ?? 'unknown'} (off-step)`
    : `${action.currentStepForShed?.stepId ?? 'unknown'} -> ${desiredStepId ?? 'unknown'}`;
  ctx.logDebug(`Capacity: ${name} violates keep invariant: step=${stepDetail}`);
};

const logSteppedLoadRestoreViolations = (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  name: string,
  params: {
    desiredStepId?: string;
    stepNeedsAdjustment: boolean;
  },
): void => {
  const { desiredStepId, stepNeedsAdjustment } = params;
  if (stepNeedsAdjustment) {
    logSteppedLoadStepViolation(ctx, action, name, desiredStepId);
  }
};

const logSteppedLoadRestoreAttemptSkip = (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    mode: PlanActuationMode;
    matchingRestoreAttempt: NonNullable<ExecutableSteppedLoadDevice['matchingRestoreAttempt']>;
  },
): false => {
  const {
    action,
    mode,
    matchingRestoreAttempt,
  } = params;
  return logSteppedLoadRestoreSkip(ctx, {
    action,
    mode,
    reasonCode: matchingRestoreAttempt.status === 'awaiting_confirmation'
      ? 'waiting_for_confirmation'
      : 'retry_backoff',
    desiredStepId: matchingRestoreAttempt.requestedStepId,
  });
};

const isStepMaterializationPending = (state: SteppedStepActuationState): boolean => (
  state.materialization.kind === 'not_materialized'
  && state.materialization.reason === 'fallback_only'
);

const maybeSkipSteppedLoadRestoreBinary = (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    snapshot: TargetDeviceSnapshot | undefined;
    mode: PlanActuationMode;
    matchingRestoreAttempt: ExecutableSteppedLoadDevice['matchingRestoreAttempt'];
    stepActuation: SteppedStepActuationState;
    stepNeedsAdjustment: boolean;
    stepViolated: boolean;
    desiredStepId?: string;
    preRestoreStepIssued?: boolean;
  },
): false | null => {
  const {
    action,
    snapshot,
    mode,
    matchingRestoreAttempt,
    stepActuation,
    stepNeedsAdjustment,
    stepViolated,
    desiredStepId,
    preRestoreStepIssued,
  } = params;
  if (!snapshot) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'missing_snapshot',
    });
  }
  if (!canTurnOnDevice(snapshot)) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'not_setable',
    });
  }
  if (ctx.state.pendingRestores.has(action.id)) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'already_in_progress',
    });
  }
  if (
    snapshot.currentOn === false
    && stepViolated
    && !isRequestedStepMaterialized(stepActuation)
  ) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'pre_restore_step_required',
      skipDetailCode: preRestoreStepIssued === true
        || matchingRestoreAttempt?.status === 'awaiting_confirmation'
        || isStepMaterializationPending(stepActuation)
        ? 'pre_restore_step_pending_confirmation'
        : 'pre_restore_step_command_not_issued',
      desiredStepId,
    });
  }
  if (snapshot.currentOn !== false && !stepNeedsAdjustment) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'no_keep_violation',
    });
  }
  return null;
};

/* eslint-disable max-params, complexity --
 * Restore evaluation still needs the full invariant context after the
 * executor split.
 */
export const applySteppedLoadRestore = async (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  snapshot: TargetDeviceSnapshot | undefined,
  mode: PlanActuationMode,
  anyShedDevices: boolean,
  options: { preRestoreStepIssued?: boolean } = {},
): Promise<boolean> => {
  const name = action.name;
  if (action.plannedState !== 'keep') {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'planned_state',
    });
  }
  if (!allowsSteppedLoadKeepInvariantRestore(action.reason)) {
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'restore_not_admitted',
      blockedByPlanReasonCode: action.reason.code,
    });
  }
  const {
    effectiveCurrentOn,
    requestedStepId,
    stepActuation,
    matchingRestoreAttempt,
    stepNeedsAdjustment,
  } = action;
  const shouldDeferRestoreForAttempt = stepNeedsAdjustment && matchingRestoreAttempt
    && (effectiveCurrentOn === true || matchingRestoreAttempt.status === 'retry_backoff');
  if (shouldDeferRestoreForAttempt) {
    return logSteppedLoadRestoreAttemptSkip(ctx, {
      action,
      mode,
      matchingRestoreAttempt,
    });
  }
  logSteppedLoadRestoreViolations(ctx, action, name, {
    desiredStepId: requestedStepId,
    stepNeedsAdjustment,
  });

  if (effectiveCurrentOn === true) {
    if (stepNeedsAdjustment) return false;
    return logSteppedLoadRestoreSkip(ctx, {
      action,
      mode,
      reasonCode: 'no_keep_violation',
    });
  }
  const stepViolated = effectiveCurrentOn === false && stepNeedsAdjustment;
  if (snapshot?.currentOn === false) {
    ctx.logDebug(`Capacity: ${name} violates keep invariant: onoff=${snapshot?.currentOn}`);
  }
  if (applyKeepInvariantShedBlock(ctx, action, name, anyShedDevices, requestedStepId)) return false;
  // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
  delete ctx.state.keepInvariantShedBlockedByDevice[action.id];
  const binaryRestoreSkip = maybeSkipSteppedLoadRestoreBinary(ctx, {
    action,
    snapshot,
    mode,
    matchingRestoreAttempt,
    stepActuation,
    stepNeedsAdjustment,
    stepViolated,
    desiredStepId: requestedStepId,
    preRestoreStepIssued: options.preRestoreStepIssued,
  });
  if (binaryRestoreSkip === false) return false;
  if (snapshot?.currentOn !== false) return true;
  return executeSteppedLoadRestoreBinary(ctx, {
    action,
    snapshot,
    mode,
    name,
    onoffViolated: snapshot?.currentOn === false,
    stepViolated,
  });
};
/* eslint-enable max-params, complexity */

export const applySteppedLoadShedOff = async (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  snapshot: TargetDeviceSnapshot | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => {
  if (action.plannedState !== 'shed' || isShedSteppedNonExecutableHoldForSnapshot(action, snapshot)) return false;
  const atOffStep = action.currentStepIsOffStep;
  if (action.shedAction !== 'turn_off' && !atOffStep) return false;
  if (!snapshot) return false;
  const name = action.name;
  try {
    const applied = await setBinaryControl({
      ...ctx.buildBinaryControlDeps(),
      deviceId: action.id,
      name,
      desired: false,
      snapshot,
      logContext: 'capacity',
      actuationMode: mode,
    });
    if (!applied) return false;
    if (mode === 'plan') {
      const now = Date.now();
      ctx.recordShedActuation(action.id, name, now);
    }
    ctx.structuredLog?.info({
      event: 'binary_command_applied',
      deviceId: action.id,
      deviceName: name,
      capabilityId: snapshot.controlCapabilityId ?? 'onoff',
      desired: false,
      mode,
      reasonCode: mode === 'reconcile' ? 'reconcile_shed' : 'full_shed_to_off',
    });
    ctx.structuredLog?.info({
      event: 'stepped_load_binary_transition_applied',
      deviceId: action.id,
      deviceName: name,
      desiredBinaryState: false,
      effectiveTransition: 'full_shed_to_off',
      stepPreparationPurpose: atOffStep ? null : 'prepare_for_off',
      transitionPhase: 'binary_transition',
      mode,
      reasonCode: mode === 'reconcile' ? 'reconcile_shed' : 'full_shed_to_off',
    });
    return true;
  } catch (error) {
    ctx.error(`Failed to turn off stepped-load device ${name} via binary control`, error);
    return false;
  }
};

const logSteppedLoadCommandSkip = (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    mode: PlanActuationMode;
    reasonCode:
      | 'missing_step'
      | 'step_up_blocked'
      | 'waiting_for_confirmation'
      | 'retry_backoff'
      | 'missing_native_command'
      | 'missing_trigger';
    logMessage: string;
    fields: Record<string, unknown>;
  },
): false => {
  const { action, mode, reasonCode, logMessage, fields } = params;
  ctx.debugStructured?.({
    event: 'stepped_load_command_skipped',
    reasonCode,
    deviceId: action.id,
    deviceName: action.name,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    logContext: 'capacity',
    actuationMode: mode,
    ...fields,
  });
  ctx.logDebug(logMessage);
  return false;
};

type ExecuteSteppedLoadCommandParams = {
  action: ExecutableSteppedLoadDevice;
  mode: PlanActuationMode;
  options: { recordPlanActuation?: boolean };
  desiredStep: NonNullable<ReturnType<typeof getSteppedLoadStep>>;
  transition: ExecutableSteppedLoadTransition | null;
  previousStepId: string | undefined;
  now: number;
};

type AcceptedSteppedLoadCommandParams = ExecuteSteppedLoadCommandParams & {
  commandTransport?: 'native_capability';
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
  ctx: PlanExecutorSteppedContext,
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
  ctx.structuredLog?.info({
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

const recordAcceptedSteppedLoadCommand = (
  ctx: PlanExecutorSteppedContext,
  params: AcceptedSteppedLoadCommandParams,
): boolean => {
  markAcceptedSteppedLoadCommand(ctx, params);
  logAcceptedSteppedLoadCommand(ctx, params);
  recordAcceptedSteppedLoadPlanActuation(ctx, params);
  return true;
};

const executeSteppedLoadCommand = async (
  ctx: PlanExecutorSteppedContext,
  params: ExecuteSteppedLoadCommandParams,
): Promise<boolean> => {
  const {
    action,
    mode,
    desiredStep,
    previousStepId,
  } = params;
  if (isNativeSteppedLoadControlEnabled(action)) {
    return executeNativeSteppedLoadCommand(ctx, params);
  }
  const triggerCard = ctx.getDesiredSteppedLoadTrigger();
  if (!triggerCard?.trigger) {
    return logSteppedLoadCommandSkip(ctx, {
      action,
      mode,
      reasonCode: 'missing_trigger',
      logMessage: 'Capacity: desired_stepped_load_changed trigger is unavailable; cannot issue stepped-load command',
      fields: { desiredStepId: desiredStep.id },
    });
  }
  const planningPowerW = desiredStep.planningPowerW;
  try {
    const triggerPromise = triggerCard.trigger({
      step_id: desiredStep.id,
      planning_power_w: planningPowerW,
      planning_current_1p_a: planningPowerW / 230,
      planning_current_3p_a: planningPowerW / (230 * 3),
      previous_step_id: previousStepId ?? '',
    }, {
      deviceId: action.id,
    });
    recordAcceptedSteppedLoadCommand(ctx, params);
    void Promise.resolve(triggerPromise).catch((error) => {
      ctx.structuredLog?.error({
        event: 'stepped_load_command_failed',
        reasonCode: 'flow_trigger_failed',
        deviceId: action.id,
        deviceName: action.name,
        desiredStepId: desiredStep.id,
        planningPowerW,
        mode,
      });
      ctx.error(`Failed to trigger stepped-load command for ${action.name}`, error);
    });
    return true;
  } catch (error) {
    ctx.structuredLog?.error({
      event: 'stepped_load_command_failed',
      reasonCode: 'flow_trigger_failed',
      deviceId: action.id,
      deviceName: action.name,
      desiredStepId: desiredStep.id,
      planningPowerW,
      mode,
    });
    ctx.error(`Failed to trigger stepped-load command for ${action.name}`, error);
    return false;
  }
};

const executeNativeSteppedLoadCommand = async (
  ctx: PlanExecutorSteppedContext,
  params: ExecuteSteppedLoadCommandParams,
): Promise<boolean> => {
  const {
    action,
    mode,
    desiredStep,
  } = params;

  try {
    const applied = await ctx.setNativeSteppedLoadStep(
      action.id,
      action.steppedLoadProfile,
      desiredStep.id,
    );
    if (!applied) {
      return logSteppedLoadCommandSkip(ctx, {
        action,
        mode,
        reasonCode: 'missing_native_command',
        logMessage: `Capacity: skip native stepped-load command for ${action.name}, `
          + `no native command for desired step ${desiredStep.id}`,
        fields: { desiredStepId: desiredStep.id },
      });
    }
    return recordAcceptedSteppedLoadCommand(ctx, {
      ...params,
      commandTransport: 'native_capability',
    });
  } catch (error) {
    ctx.structuredLog?.error({
      event: 'stepped_load_command_failed',
      reasonCode: 'native_capability_failed',
      deviceId: action.id,
      deviceName: action.name,
      desiredStepId: desiredStep.id,
      planningPowerW: desiredStep.planningPowerW,
      mode,
    });
    ctx.error(`Failed to set native stepped-load command for ${action.name}`, error);
    return false;
  }
};

const logSteppedLoadRestoreSkip = (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    mode: PlanActuationMode;
    reasonCode:
      | 'planned_state'
      | 'no_keep_violation'
      | 'restore_not_admitted'
      | 'waiting_for_confirmation'
      | 'retry_backoff'
      | 'missing_snapshot'
      | 'not_setable'
      | 'already_in_progress'
      | 'pre_restore_step_required';
    skipDetailCode?:
      | 'pre_restore_step_pending_confirmation'
      | 'pre_restore_step_command_not_issued';
    blockedByPlanReasonCode?: PlanReasonCode;
    desiredStepId?: string;
  },
): false => {
  const {
    action,
    mode,
    reasonCode,
    skipDetailCode,
    blockedByPlanReasonCode,
    desiredStepId,
  } = params;
  ctx.debugStructured?.({
    event: 'restore_command_skipped',
    reasonCode,
    ...(skipDetailCode ? { skipDetailCode } : {}),
    ...(blockedByPlanReasonCode ? { blockedByPlanReasonCode } : {}),
    ...(desiredStepId ? { desiredStepId } : {}),
    deviceId: action.id,
    deviceName: action.name,
    logContext: 'capacity',
    actuationMode: mode,
  });
  return false;
};

const executeSteppedLoadRestoreBinary = async (
  ctx: PlanExecutorSteppedContext,
  params: {
    action: ExecutableSteppedLoadDevice;
    snapshot: TargetDeviceSnapshot;
    mode: PlanActuationMode;
    name: string;
    onoffViolated: boolean;
    stepViolated: boolean;
  },
): Promise<boolean> => {
  const {
    action,
    snapshot,
    mode,
    name,
    onoffViolated,
    stepViolated,
  } = params;
  ctx.state.pendingRestores.add(action.id);
  try {
    const applied = await setBinaryControl({
      ...ctx.buildBinaryControlDeps(),
      deviceId: action.id,
      name,
      desired: true,
      snapshot,
      logContext: 'capacity',
      restoreSource: ctx.getRestoreLogSource(action.id),
      actuationMode: mode,
    });
    if (!applied) return false;
    ctx.structuredLog?.info({
      event: 'stepped_load_binary_transition_applied',
      deviceId: action.id,
      deviceName: name,
      desiredBinaryState: true,
      effectiveTransition: 'restore_from_off_at_low',
      stepPreparationPurpose: stepViolated ? 'prepare_for_on' : null,
      transitionPhase: 'binary_transition',
      mode,
      onoffViolated,
      stepViolated,
      reasonCode: 'keep_invariant',
    });
    if (mode === 'plan') {
      const now = Date.now();
      ctx.recordRestoreActuation(action.id, name, now);
      recordActivationAttemptStarted({
        state: ctx.state,
        diagnostics: ctx.deviceDiagnostics,
        deviceId: action.id,
        name,
        nowTs: now,
      });
    } else if (mode === 'reconcile') {
      recordActivationSetbackForDevice({
        state: ctx.state,
        diagnostics: ctx.deviceDiagnostics,
        deviceId: action.id,
        name,
        nowTs: Date.now(),
      });
    }
    return true;
  } catch (error) {
    ctx.error(`Failed to restore stepped-load device ${name} via binary control`, error);
    return false;
  } finally {
    ctx.state.pendingRestores.delete(action.id);
  }
};

const applyKeepInvariantShedBlock = (
  ctx: PlanExecutorSteppedContext,
  action: ExecutableSteppedLoadDevice,
  name: string,
  anyShedDevices: boolean,
  desiredStepId?: string,
): boolean => {
  if (!anyShedDevices || !desiredStepId) return false;
  const lowestNonZeroStep = getSteppedLoadLowestActiveStep(action.steppedLoadProfile);
  const desiredStep = getSteppedLoadStep(action.steppedLoadProfile, desiredStepId);
  if (!lowestNonZeroStep || !desiredStep || desiredStep.planningPowerW <= lowestNonZeroStep.planningPowerW) {
    return false;
  }
  ctx.logDebug(`Capacity: skip stepped-load restore for ${name}, shed invariant: `
    + `desiredStep=${desiredStepId} exceeds lowestNonZeroStep=${lowestNonZeroStep.id}`);
  const prevBlock = ctx.state.keepInvariantShedBlockedByDevice[action.id];
  const unchanged = prevBlock !== undefined
    && prevBlock.desiredStepId === desiredStepId
    && prevBlock.lowestNonZeroStepId === lowestNonZeroStep.id;
  if (!unchanged) {
    ctx.debugStructured?.({
      event: 'restore_keep_invariant_shed_blocked',
      reasonCode: 'shed_invariant',
      deviceId: action.id,
      deviceName: name,
      desiredStepId,
      lowestNonZeroStepId: lowestNonZeroStep.id,
      rejectionReason: 'shed_invariant',
    });
    // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
    ctx.state.keepInvariantShedBlockedByDevice[action.id] = {
      desiredStepId,
      lowestNonZeroStepId: lowestNonZeroStep.id,
    };
  }
  return true;
};
