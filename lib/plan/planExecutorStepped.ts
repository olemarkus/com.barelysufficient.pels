/* eslint-disable max-lines --
 * Extracted stepped-load actuation remains one cohesive invariant-heavy
 * pipeline after the executor split.
 */
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
} from '../utils/deviceControlProfiles';
import type { TargetDeviceSnapshot } from '../utils/types';
import {
  canTurnOnDevice,
  recordActivationAttemptStarted,
  recordActivationSetbackForDevice,
} from './planExecutorSupport';
import { setBinaryControl } from './planBinaryControl';
import { resolveEffectiveCurrentOn } from './planCurrentState';
import { resolveSteppedLoadCommandPendingMs } from './planObservationPolicy';
import {
  isSteppedLoadDevice,
  resolveSteppedKeepDesiredStepId,
  resolveSteppedLoadTransition,
  type SteppedLoadTransition,
} from './planSteppedLoad';
import type { PlanActuationMode } from './planExecutor';
import type { DevicePlan } from './planTypes';
import type { PlanEngineState } from './planState';
import type { DeviceManager } from '../core/deviceManager';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';

type PlanDevice = DevicePlan['devices'][number];

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
  dev: PlanDevice,
  mode: PlanActuationMode,
  options: { recordPlanActuation?: boolean } = {},
): Promise<boolean> => {
  if (!isSteppedLoadDevice(dev)) return false;
  const profile = dev.steppedLoadProfile;
  if (!profile) return false;
  const plannedDesiredStepId = resolveSteppedKeepDesiredStepId(dev);
  const transition = resolveSteppedLoadTransition(dev, plannedDesiredStepId);
  const commandStepId = transition?.commandStepId ?? plannedDesiredStepId;
  if (!commandStepId || commandStepId === dev.selectedStepId) return false;
  const desiredStep = getSteppedLoadStep(profile, commandStepId);
  if (!desiredStep) {
    return logSteppedLoadCommandSkip(ctx, {
      dev,
      mode,
      reasonCode: 'missing_step',
      logMessage: `Capacity: skip stepped-load command for ${dev.name}, `
        + `desired step ${commandStepId} is not in profile`,
      fields: { desiredStepId: commandStepId, plannedDesiredStepId: plannedDesiredStepId ?? null },
    });
  }
  if (dev.plannedState === 'shed') {
    const selectedStep = dev.selectedStepId ? getSteppedLoadStep(profile, dev.selectedStepId) : null;
    const selectedPowerW = selectedStep?.planningPowerW ?? 0;
    if (desiredStep.planningPowerW > selectedPowerW) {
      return logSteppedLoadCommandSkip(ctx, {
        dev,
        mode,
        reasonCode: 'step_up_blocked',
        logMessage: `Capacity: skip step command for ${dev.name}, shed device has upward`
          + ` desiredStepId=${commandStepId} vs selectedStepId=${dev.selectedStepId ?? 'unknown'}`
          + ` (power ${selectedPowerW}W)`,
        fields: { desiredStepId: commandStepId, selectedStepId: dev.selectedStepId ?? null },
      });
    }
  }
  const now = Date.now();
  const previousStepId = dev.selectedStepId ?? dev.lastDesiredStepId;
  const sameDesiredStepPendingState = getSameDesiredStepPendingState(dev, commandStepId, now);
  if (sameDesiredStepPendingState === 'pending') {
    return logSteppedLoadCommandSkip(ctx, {
      dev,
      mode,
      reasonCode: 'waiting_for_confirmation',
      logMessage: `Capacity: skip stepped-load command for ${dev.name}, `
        + `awaiting confirmation of ${commandStepId}`,
      fields: { desiredStepId: commandStepId, plannedDesiredStepId: plannedDesiredStepId ?? null },
    });
  }
  if (sameDesiredStepPendingState === 'backoff') {
    return logSteppedLoadCommandSkip(ctx, {
      dev,
      mode,
      reasonCode: 'retry_backoff',
      logMessage: `Capacity: skip stepped-load command for ${dev.name}, `
        + `retry backoff for ${commandStepId} remains active`,
      fields: {
        desiredStepId: commandStepId,
        nextRetryAtMs: dev.nextStepCommandRetryAtMs ?? null,
        retryCount: dev.stepCommandRetryCount ?? 0,
      },
    });
  }
  return executeSteppedLoadCommand(ctx, {
    dev,
    mode,
    options,
    desiredStep,
    transition,
    previousStepId,
    now,
  });
};
/* eslint-enable complexity */

/* eslint-disable max-params, complexity, sonarjs/cognitive-complexity --
 * Restore evaluation still needs the full invariant context after the
 * executor split.
 */
export const applySteppedLoadRestore = async (
  ctx: PlanExecutorSteppedContext,
  dev: PlanDevice,
  snapshot: TargetDeviceSnapshot | undefined,
  mode: PlanActuationMode,
  anyShedDevices: boolean,
  options: { preRestoreStepIssued?: boolean } = {},
): Promise<boolean> => {
  const name = dev.name;
  if (dev.plannedState !== 'keep') {
    return logSteppedLoadRestoreSkip(ctx, {
      dev,
      mode,
      reasonCode: 'planned_state',
      logMessage: `Capacity: skip stepped-load restore for ${name}, plannedState is ${dev.plannedState}`,
    });
  }
  const effectiveCurrentOn = resolveEffectiveCurrentOn(dev);
  if (effectiveCurrentOn !== false) {
    return logSteppedLoadRestoreSkip(ctx, {
      dev,
      mode,
      reasonCode: 'current_state',
      logMessage: `Capacity: skip stepped-load restore for ${name}, currentState is ${dev.currentState}`,
    });
  }
  const onoffViolated = snapshot?.currentOn === false;
  const desiredStepId = resolveSteppedKeepDesiredStepId(dev);
  const hasPendingMatchingRestoreStep = desiredStepId !== undefined
    && dev.stepCommandPending === true
    && dev.lastDesiredStepId === desiredStepId;
  const desiredIsNonOff = desiredStepId
    && dev.steppedLoadProfile
    && !isSteppedLoadOffStep(dev.steppedLoadProfile, desiredStepId);
  const stepViolated = Boolean(
    effectiveCurrentOn === false
    && desiredIsNonOff
    && desiredStepId !== dev.selectedStepId,
  );
  if (onoffViolated) {
    ctx.logDebug(`Capacity: ${name} violates keep invariant: onoff=${snapshot?.currentOn}`);
  }
  if (stepViolated) {
    const stepDetail = dev.steppedLoadProfile && dev.selectedStepId
      && isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId)
      ? `${dev.selectedStepId} (off-step)`
      : `${dev.selectedStepId ?? 'unknown'} -> ${desiredStepId ?? 'unknown'}`;
    ctx.logDebug(`Capacity: ${name} violates keep invariant: step=${stepDetail}`);
  }
  if (!onoffViolated && !stepViolated) {
    return logSteppedLoadRestoreSkip(ctx, {
      dev,
      mode,
      reasonCode: 'no_keep_violation',
      logMessage:
        `Capacity: skip stepped-load restore for ${name}, `
        + 'no keep violations detected',
    });
  }
  if (applyKeepInvariantShedBlock(ctx, dev, name, anyShedDevices, desiredStepId)) return false;
  // eslint-disable-next-line no-param-reassign -- Shared executor state update.
  delete ctx.state.keepInvariantShedBlockedByDevice[dev.id];
  if (!snapshot) {
    return logSteppedLoadRestoreSkip(ctx, {
      dev,
      mode,
      reasonCode: 'missing_snapshot',
      logMessage: `Capacity: skip stepped-load restore for ${name}, no snapshot available`,
    });
  }
  if (!canTurnOnDevice(snapshot)) {
    return logSteppedLoadRestoreSkip(ctx, {
      dev,
      mode,
      reasonCode: 'not_setable',
      logMessage: `Capacity: skip stepped-load restore for ${name}, cannot turn on from current snapshot`,
    });
  }
  if (ctx.state.pendingRestores.has(dev.id)) {
    return logSteppedLoadRestoreSkip(ctx, {
      dev,
      mode,
      reasonCode: 'already_in_progress',
      logMessage: `Capacity: skip stepped-load restore for ${name}, already in progress`,
    });
  }
  if (onoffViolated && stepViolated && options.preRestoreStepIssued !== true && !hasPendingMatchingRestoreStep) {
    return logSteppedLoadRestoreSkip(ctx, {
      dev,
      mode,
      reasonCode: 'pre_restore_step_required',
      logMessage:
        `Capacity: skip stepped-load restore for ${name}, `
        + 'required pre-restore step command was not issued',
    });
  }
  if (!onoffViolated) return true;
  return executeSteppedLoadRestoreBinary(ctx, { dev, snapshot, mode, name, onoffViolated, stepViolated });
};
/* eslint-enable max-params, complexity, sonarjs/cognitive-complexity */

/* eslint-disable complexity --
 * Stepped-load shed-off still combines off-step validation with binary
 * actuation and transition logging in one path.
 */
export const applySteppedLoadShedOff = async (
  ctx: PlanExecutorSteppedContext,
  dev: PlanDevice,
  snapshot: TargetDeviceSnapshot | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => {
  if (dev.plannedState !== 'shed') return false;
  const atOffStep = dev.steppedLoadProfile
    && dev.selectedStepId
    && isSteppedLoadOffStep(dev.steppedLoadProfile, dev.selectedStepId);
  if (dev.shedAction !== 'turn_off' && !atOffStep) return false;
  if (!snapshot) return false;
  const name = dev.name;
  try {
    const applied = await setBinaryControl({
      ...ctx.buildBinaryControlDeps(),
      deviceId: dev.id,
      name,
      desired: false,
      snapshot,
      logContext: 'capacity',
      actuationMode: mode,
    });
    if (!applied) return false;
    if (mode === 'plan') {
      const now = Date.now();
      ctx.recordShedActuation(dev.id, name, now);
    }
    ctx.structuredLog?.info({
      event: 'binary_command_applied',
      deviceId: dev.id,
      deviceName: name,
      capabilityId: snapshot.controlCapabilityId ?? 'onoff',
      desired: false,
      mode,
      reasonCode: mode === 'reconcile' ? 'reconcile_shed' : 'full_shed_to_off',
    });
    ctx.structuredLog?.info({
      event: 'stepped_load_binary_transition_applied',
      deviceId: dev.id,
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
/* eslint-enable complexity */

const logSteppedLoadCommandSkip = (
  ctx: PlanExecutorSteppedContext,
  params: {
    dev: PlanDevice;
    mode: PlanActuationMode;
    reasonCode:
      | 'missing_step'
      | 'step_up_blocked'
      | 'waiting_for_confirmation'
      | 'retry_backoff'
      | 'missing_trigger';
    logMessage: string;
    fields: Record<string, unknown>;
  },
): false => {
  const { dev, mode, reasonCode, logMessage, fields } = params;
  ctx.debugStructured?.({
    event: 'stepped_load_command_skipped',
    reasonCode,
    deviceId: dev.id,
    deviceName: dev.name,
    logContext: 'capacity',
    actuationMode: mode,
    ...fields,
  });
  ctx.logDebug(logMessage);
  return false;
};

function getSameDesiredStepPendingState(
  dev: Pick<
    PlanDevice,
    | 'lastDesiredStepId'
    | 'stepCommandPending'
    | 'stepCommandStatus'
    | 'nextStepCommandRetryAtMs'
  >,
  desiredStepId: string,
  nowMs: number = Date.now(),
): 'pending' | 'backoff' | null {
  if (dev.lastDesiredStepId !== desiredStepId) return null;
  if (dev.stepCommandPending) return 'pending';
  if (
    dev.stepCommandStatus === 'stale'
    && typeof dev.nextStepCommandRetryAtMs === 'number'
    && nowMs < dev.nextStepCommandRetryAtMs
  ) {
    return 'backoff';
  }
  return null;
}

/* eslint-disable complexity --
 * Stepped-load command execution couples trigger dispatch with state tracking
 * and restore/shed diagnostics.
 */
const executeSteppedLoadCommand = async (
  ctx: PlanExecutorSteppedContext,
  params: {
    dev: PlanDevice;
    mode: PlanActuationMode;
    options: { recordPlanActuation?: boolean };
    desiredStep: NonNullable<ReturnType<typeof getSteppedLoadStep>>;
    transition: SteppedLoadTransition | null;
    previousStepId: string | undefined;
    now: number;
  },
): Promise<boolean> => {
  const {
    dev,
    mode,
    options,
    desiredStep,
    transition,
    previousStepId,
    now,
  } = params;
  const triggerCard = ctx.getDesiredSteppedLoadTrigger();
  if (!triggerCard?.trigger) {
    return logSteppedLoadCommandSkip(ctx, {
      dev,
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
      previous_step_id: previousStepId ?? '',
    }, {
      deviceId: dev.id,
    });
    ctx.markSteppedLoadDesiredStepIssued({
      deviceId: dev.id,
      desiredStepId: desiredStep.id,
      previousStepId,
      issuedAtMs: now,
      pendingWindowMs: resolveSteppedLoadCommandPendingMs(dev.communicationModel),
    });
    ctx.structuredLog?.info({
      event: 'stepped_load_command_requested',
      deviceId: dev.id,
      deviceName: dev.name,
      previousStepId: previousStepId ?? null,
      desiredStepId: desiredStep.id,
      plannedDesiredStepId: transition?.plannedDesiredStepId ?? desiredStep.id,
      planningPowerW,
      commandPurpose: transition?.stepPreparationPurpose ? 'step_preparation' : 'step_adjustment',
      stepPreparationPurpose: transition?.stepPreparationPurpose ?? null,
      effectiveTransition: transition?.effectiveTransition ?? 'steady',
      binaryTarget: transition?.binaryTarget ?? null,
      transitionPhase: transition?.transitionPhase ?? 'settled',
      mode,
    });
    void Promise.resolve(triggerPromise).catch((error) => {
      ctx.structuredLog?.error({
        event: 'stepped_load_command_failed',
        reasonCode: 'flow_trigger_failed',
        deviceId: dev.id,
        deviceName: dev.name,
        desiredStepId: desiredStep.id,
        planningPowerW,
        mode,
      });
      ctx.error(`Failed to trigger stepped-load command for ${dev.name}`, error);
    });
    const shouldRecordPlanActuation = options.recordPlanActuation !== false;
    if (mode !== 'plan' || !shouldRecordPlanActuation) return true;
    if (transition?.effectiveTransition === 'step_down_while_on') {
      ctx.recordShedActuation(dev.id, dev.name, now);
      return true;
    }
    if (
      transition?.effectiveTransition !== 'step_up_while_on'
      && transition?.effectiveTransition !== 'restore_from_off_at_low'
    ) return true;
    ctx.recordRestoreActuation(dev.id, dev.name, now);
    recordActivationAttemptStarted({
      state: ctx.state,
      diagnostics: ctx.deviceDiagnostics,
      deviceId: dev.id,
      name: dev.name,
      nowTs: now,
      source: 'tracked_step_up',
    });
    return true;
  } catch (error) {
    ctx.structuredLog?.error({
      event: 'stepped_load_command_failed',
      reasonCode: 'flow_trigger_failed',
      deviceId: dev.id,
      deviceName: dev.name,
      desiredStepId: desiredStep.id,
      planningPowerW,
      mode,
    });
    ctx.error(`Failed to trigger stepped-load command for ${dev.name}`, error);
    return false;
  }
};
/* eslint-enable complexity */

const logSteppedLoadRestoreSkip = (
  ctx: PlanExecutorSteppedContext,
  params: {
    dev: PlanDevice;
    mode: PlanActuationMode;
    reasonCode:
      | 'planned_state'
      | 'current_state'
      | 'no_keep_violation'
      | 'missing_snapshot'
      | 'not_setable'
      | 'already_in_progress'
      | 'pre_restore_step_required';
    logMessage: string;
  },
): false => {
  const { dev, mode, reasonCode, logMessage } = params;
  ctx.debugStructured?.({
    event: 'restore_command_skipped',
    reasonCode,
    deviceId: dev.id,
    deviceName: dev.name,
    logContext: 'capacity',
    actuationMode: mode,
  });
  ctx.logDebug(logMessage);
  return false;
};

const executeSteppedLoadRestoreBinary = async (
  ctx: PlanExecutorSteppedContext,
  params: {
    dev: PlanDevice;
    snapshot: TargetDeviceSnapshot;
    mode: PlanActuationMode;
    name: string;
    onoffViolated: boolean;
    stepViolated: boolean;
  },
): Promise<boolean> => {
  const {
    dev,
    snapshot,
    mode,
    name,
    onoffViolated,
    stepViolated,
  } = params;
  ctx.state.pendingRestores.add(dev.id);
  try {
    const applied = await setBinaryControl({
      ...ctx.buildBinaryControlDeps(),
      deviceId: dev.id,
      name,
      desired: true,
      snapshot,
      logContext: 'capacity',
      restoreSource: ctx.getRestoreLogSource(dev.id),
      actuationMode: mode,
    });
    if (!applied) return false;
    ctx.structuredLog?.info({
      event: 'stepped_load_binary_transition_applied',
      deviceId: dev.id,
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
      ctx.recordRestoreActuation(dev.id, name, now);
      recordActivationAttemptStarted({
        state: ctx.state,
        diagnostics: ctx.deviceDiagnostics,
        deviceId: dev.id,
        name,
        nowTs: now,
      });
    } else if (mode === 'reconcile') {
      recordActivationSetbackForDevice({
        state: ctx.state,
        diagnostics: ctx.deviceDiagnostics,
        deviceId: dev.id,
        name,
        nowTs: Date.now(),
      });
    }
    return true;
  } catch (error) {
    ctx.error(`Failed to restore stepped-load device ${name} via binary control`, error);
    return false;
  } finally {
    ctx.state.pendingRestores.delete(dev.id);
  }
};

const applyKeepInvariantShedBlock = (
  ctx: PlanExecutorSteppedContext,
  dev: PlanDevice,
  name: string,
  anyShedDevices: boolean,
  desiredStepId?: string,
): boolean => {
  if (!anyShedDevices || !dev.steppedLoadProfile || !desiredStepId) return false;
  const lowestNonZeroStep = getSteppedLoadLowestActiveStep(dev.steppedLoadProfile);
  const desiredStep = getSteppedLoadStep(dev.steppedLoadProfile, desiredStepId);
  if (!lowestNonZeroStep || !desiredStep || desiredStep.planningPowerW <= lowestNonZeroStep.planningPowerW) {
    return false;
  }
  ctx.logDebug(`Capacity: skip stepped-load restore for ${name}, shed invariant: `
    + `desiredStep=${desiredStepId} exceeds lowestNonZeroStep=${lowestNonZeroStep.id}`);
  const prevBlock = ctx.state.keepInvariantShedBlockedByDevice[dev.id];
  const unchanged = prevBlock !== undefined
    && prevBlock.desiredStepId === desiredStepId
    && prevBlock.lowestNonZeroStepId === lowestNonZeroStep.id;
  if (!unchanged) {
    ctx.debugStructured?.({
      event: 'restore_keep_invariant_shed_blocked',
      reasonCode: 'shed_invariant',
      deviceId: dev.id,
      deviceName: name,
      desiredStepId,
      lowestNonZeroStepId: lowestNonZeroStep.id,
      rejectionReason: 'shed_invariant',
    });
    // eslint-disable-next-line no-param-reassign -- Shared executor state update.
    ctx.state.keepInvariantShedBlockedByDevice[dev.id] = {
      desiredStepId,
      lowestNonZeroStepId: lowestNonZeroStep.id,
    };
  }
  return true;
};
