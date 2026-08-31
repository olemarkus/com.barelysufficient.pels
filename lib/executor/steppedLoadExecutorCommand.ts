import {
  getSteppedLoadStep,
} from '../utils/deviceControlProfiles';
import type { SteppedLoadStep } from '../../packages/contracts/src/types';
import {
  recordActivationAttemptStarted,
} from './executorSupport';
import { resolveControlCommandConfirmationMs } from '../observer/controlCommandConfirmation';
import { isRequestedStepMaterialized } from './steppedLoadActuation';
import type {
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadTransition,
} from './executablePlan';
import {
  PELS_TARGET_STEP_CAPABILITY_ID,
  type SteppedLoadStepRequestTransport,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { getLogger } from '../logging/logger';
import { isHomeyRequestTimeout } from '../utils/errorUtils';
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
  commandStepId: string,
): boolean => {
  const sameDesiredStepPendingState = action.matchingCommandAttempt;
  if (sameDesiredStepPendingState?.status === 'awaiting_confirmation') {
    logSteppedLoadCommandSkip(ctx, {
      action,
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
    reasonCode:
      | 'missing_step'
      | 'waiting_for_confirmation'
      | 'retry_backoff'
      | 'command_unavailable';
    logMessage: string;
    fields: Record<string, unknown>;
  },
): false => {
  const { action, reasonCode, logMessage, fields } = params;
  logger.debug({
    event: 'stepped_load_command_skipped',
    reasonCode,
    deviceId: action.id,
    deviceName: action.name,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    logContext: 'capacity',
    ...fields,
  });
  logger.debug({ event: 'executor_stepped_log_debug', msg: logMessage });
  return false;
};

export type ExecuteSteppedLoadCommandParams = {
  action: ExecutableSteppedLoadDevice;
  options: {
    recordPlanActuation?: boolean;
    preserveMaterializedConfirmation?: boolean;
    commandPurpose?: 'post_activation_step';
    forceAgainstReleasedOpposing?: boolean;
  };
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
    transition,
    options,
  } = params;
  if (
    options.preserveMaterializedConfirmation === true
    && isRequestedStepMaterialized(action.commandStepActuation)
  ) return;
  if (transition?.effectiveTransition === 'initialize_unknown_step_at_low') {
    ctx.markSteppedLoadDesiredStepIssued({
      deviceId: action.id,
      desiredStepId: desiredStep.id,
      issuedAtMs: now,
      confirmationPolicy: 'assume_applied',
    });
    return;
  }
  ctx.markSteppedLoadDesiredStepIssued({
    deviceId: action.id,
    desiredStepId: desiredStep.id,
    previousStepId,
    issuedAtMs: now,
    pendingWindowMs: resolveControlCommandConfirmationMs(action.communicationModel ?? 'local'),
  });
};

const resolveCommandPurpose = (
  transition: ExecutableSteppedLoadTransition | null | undefined,
  override?: 'post_activation_step',
): 'step_initialization' | 'step_preparation' | 'step_adjustment' | 'post_activation_step' => {
  if (override) return override;
  if (transition?.stepPreparationPurpose === 'initialize_unknown_step') {
    return 'step_initialization';
  }
  if (transition?.stepPreparationPurpose) return 'step_preparation';
  return 'step_adjustment';
};

const logAcceptedSteppedLoadCommand = (
  _ctx: PlanExecutorSteppedContext,
  params: AcceptedSteppedLoadCommandParams,
): void => {
  const {
    action,
    desiredStep,
    transition,
    previousStepId,
    commandTransport,
    options,
  } = params;
  const commandPurpose = resolveCommandPurpose(transition, options.commandPurpose);
  const postActivation = commandPurpose === 'post_activation_step';
  const transitionFields = transition ? {
    plannedDesiredStepId: transition.plannedDesiredStepId ?? desiredStep.id,
    commandPurpose,
    stepPreparationPurpose: postActivation ? null : (transition.stepPreparationPurpose ?? null),
    effectiveTransition: transition.effectiveTransition,
    binaryTarget: transition.binaryTarget ?? null,
    transitionPhase: postActivation ? 'post_activation' : transition.transitionPhase,
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
  });
};

const recordAcceptedSteppedLoadPlanActuation = (
  ctx: PlanExecutorSteppedContext,
  params: AcceptedSteppedLoadCommandParams,
  // An unacknowledged write still stamps the cooldown CLOCKS — see the caller
  // for why that is the conservative reading in both directions — but it must
  // not open a starvation activation attempt, because that is a claim about
  // what the DEVICE started doing, and nothing here saw the device do anything.
  options?: { recordActivationAttempt?: boolean },
): void => {
  const {
    action,
    options: commandOptions,
    transition,
    now,
  } = params;
  const shouldRecordPlanActuation = commandOptions.recordPlanActuation !== false;
  if (!shouldRecordPlanActuation) return;
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
  if (options?.recordActivationAttempt === false) return;
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
  // Load-bearing, not cosmetic: this gates `recordRestoreActuation`, which
  // stamps the restore cooldown. A shed device observed BELOW its decided rung
  // is commanded up, so the power comparison alone would read that as a restore.
  if (action.plannedShedTarget !== undefined || !previousStepId) return false;
  const previousStep = getSteppedLoadStep(action.steppedLoadProfile, previousStepId);
  const desiredStep = getSteppedLoadStep(action.steppedLoadProfile, desiredStepId);
  return Boolean(previousStep && desiredStep && desiredStep.planningPowerW > previousStep.planningPowerW);
};

/**
 * The stepped twin of `binaryControlDispatch`'s outcome-unknown branch: a write
 * we abandoned at our end is UNKNOWN, not failed, and it is resolved exactly
 * like a slow success. The command stays issued with confirmation REQUIRED, so
 * observed truth still has to arrive through telemetry — nothing here asserts
 * the device moved. What it does assert is that PELS asked, which is what keeps
 * the next cycle from reading the unchanged device as external drift and from
 * re-issuing immediately (a re-issued step command against a device whose hub
 * is already struggling is the thrash this branch exists to stop: because a
 * definite failure writes no pending record, nothing paced the next attempt and
 * the retry cadence WAS the transport timeout, which is how prod produced bursts
 * of a dozen retries spaced exactly 30 s apart against a cloud-backed device
 * that was answering none of them).
 *
 * Never `assume_applied` — that is the one policy that would settle the device
 * on an unacknowledged write.
 */
const markUnacknowledgedSteppedLoadCommand = (
  ctx: PlanExecutorSteppedContext,
  params: AcceptedSteppedLoadCommandParams,
): void => {
  const {
    action, desiredStep, previousStepId, now, transition,
  } = params;
  // Deliberately WITHOUT the accepted path's `preserveMaterializedConfirmation`
  // guard, and the omission is load-bearing.
  //
  // That guard keeps an existing materialized confirmation rather than
  // downgrading it to pending — sound when the write SUCCEEDED. It does not
  // transfer to a write nobody answered. The caller that sets the flag is the
  // post-activation reassertion (`planExecutorDispatch.ts`), which exists
  // precisely because a binary activation can reset the device-side step limit
  // even when the stale observation still matches the desired step
  // (`lib/executor/AGENTS.md`). Preserving that pre-activation evidence here
  // would let a reassertion nobody acknowledged read as settled, so nothing
  // would retry it and the device would keep running at its reset — possibly
  // HIGHER — rung. Recording the pending state is what keeps it retryable.
  // The one transition that records NOTHING on an unacknowledged write.
  // Seeding an unknown-step device at its lowest rung is a one-shot: the
  // accepted path spends it by setting the `assume_applied` latch, and any
  // record at all — even a plain pending one — marks the device as having a
  // prior step command, which permanently closes the initialization gate for
  // this on-session WITHOUT leaving the assumed step behind. The device would
  // then be commanded straight to its full desired rung, skipping the seed-low
  // ordering that exists for safety, on the one hub that just failed to answer.
  // Recording nothing keeps initialization retriable, which is what a timeout
  // did before this branch existed.
  if (transition?.effectiveTransition === 'initialize_unknown_step_at_low') return;
  ctx.markSteppedLoadDesiredStepIssued({
    deviceId: action.id,
    desiredStepId: desiredStep.id,
    previousStepId,
    issuedAtMs: now,
    pendingWindowMs: resolveControlCommandConfirmationMs(action.communicationModel ?? 'local'),
    unacknowledged: true,
  });
};

type UnacknowledgedSteppedLoadCommandParams = AcceptedSteppedLoadCommandParams & {
  /** Which channel left the command unacknowledged — both mean the same thing. */
  unacknowledgedReason: 'command_request_timed_out' | 'flow_trigger_timeout';
  err?: unknown;
};

const logUnacknowledgedSteppedLoadCommand = (
  params: UnacknowledgedSteppedLoadCommandParams,
): void => {
  const {
    action, desiredStep, previousStepId, transition, options,
    commandTransport, unacknowledgedReason, err,
  } = params;
  logger.warn({
    event: 'stepped_load_command_outcome_unknown',
    reasonCode: unacknowledgedReason,
    deviceId: action.id,
    deviceName: action.name,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    previousStepId: previousStepId ?? null,
    desiredStepId: desiredStep.id,
    planningPowerW: desiredStep.planningPowerW,
    commandPurpose: resolveCommandPurpose(transition, options.commandPurpose),
    // The direction is load-bearing here, not decoration: it selects which
    // cooldown clock the unacknowledged write stamped.
    effectiveTransition: transition?.effectiveTransition ?? 'steady',
    plannedDesiredStepId: transition?.plannedDesiredStepId ?? desiredStep.id,
    ...(commandTransport ? { commandTransport } : {}),
    ...(err === undefined ? {} : { err }),
  });
};

/**
 * `requested: false` covers two unrelated outcomes, and the producer is the only
 * one that can tell them apart — so it does, handing over a typed `reason`
 * rather than leaving this layer to infer it. A Flow trigger that went out and
 * was never acknowledged is the SAME outcome as the native channel's transport
 * timeout and takes the same branch; anything else means there was no transport
 * to try, which is an ordinary skip.
 */
const handleUnrequestedSteppedLoadResult = (
  ctx: PlanExecutorSteppedContext,
  params: ExecuteSteppedLoadCommandParams,
  reason: 'flow_trigger_timeout' | undefined,
): boolean => {
  const { action, desiredStep } = params;
  if (reason !== 'flow_trigger_timeout') {
    return logSteppedLoadCommandSkip(ctx, {
      action,
      reasonCode: 'command_unavailable',
      logMessage: `Capacity: skip stepped-load command for ${action.name}, `
        + `no command transport for desired step ${desiredStep.id}`,
      fields: { desiredStepId: desiredStep.id },
    });
  }
  if (ctx.isSteppedCommandAuthorityCurrent?.() === false) return false;
  return recordUnacknowledgedSteppedLoadCommand(ctx, {
    ...params,
    commandTransport: 'flow',
    unacknowledgedReason: 'flow_trigger_timeout',
  });
};

/**
 * The cooldown clocks are stamped as if the command landed, in BOTH directions.
 *
 * That is the conservative reading, not a guess: every clock here is
 * RESTRICTIVE with respect to future actuation. `recordShedActuation` writes
 * `lastInstabilityMs`, which drives the exponential restore back-off;
 * `recordRestoreActuation` writes `lastRestoreMs`, the restore cooldown itself.
 * Assuming an unconfirmed write happened therefore delays the next resume
 * whichever way it went — and a resume is the direction that ADDS load. The
 * opposite choice is the unsafe one: if an unacknowledged step-up did land (the
 * common case for a socket we abandoned on a slow-but-alive hub) and nothing
 * stamps the clock, the next rebuild may resume another device with no cooldown
 * at all, stacking load onto a meter that has not yet seen the first increase.
 *
 * Both clocks are home-wide, so neither direction is the "safe" one to skip on
 * blast-radius grounds; the tie is broken by which way the error points.
 *
 * What an unacknowledged write must NOT do is conclude something about the
 * DEVICE. `recordActivationAttemptStarted` opens a starvation activation
 * attempt — a claim that this device began drawing — on evidence that never
 * arrived, so it is suppressed. Same reason the write arms no target-power
 * reachability probe.
 *
 * The retry pacing this used to be credited with is not from these clocks: the
 * pending record's own ladder (`STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS`, 30 s →
 * 2 m → 5 m → 15 m) is what replaced the burst of 30 s-spaced retries.
 */
const recordUnacknowledgedSteppedLoadCommand = (
  ctx: PlanExecutorSteppedContext,
  params: UnacknowledgedSteppedLoadCommandParams,
): boolean => {
  markUnacknowledgedSteppedLoadCommand(ctx, params);
  logUnacknowledgedSteppedLoadCommand(params);
  recordAcceptedSteppedLoadPlanActuation(ctx, params, { recordActivationAttempt: false });
  return true;
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
    desiredStep,
    previousStepId,
  } = params;
  const planningPowerW = desiredStep.planningPowerW;
  const planningCurrentA = resolvePlanningCurrentA(desiredStep);
  if (
    ctx.steppedCommandOwner === 'ordinary'
    && ctx.isLifecycleFallbackActive?.(action.id) === true
  ) return false;
  if (!ctx.steppedCommandClaim.acquire(
    action.id,
    ctx.steppedCommandOwner,
    desiredStep.id,
    ctx.onSteppedCommandClaimReleased,
  )) return false;
  let accepted = false;
  try {
    const result = await ctx.requestSteppedLoadStep({
      deviceId: action.id,
      profile: action.steppedLoadProfile,
      desiredStepId: desiredStep.id,
      planningPowerW,
      planningCurrentA,
      previousStepId,
    });
    if (!result.requested) {
      accepted = handleUnrequestedSteppedLoadResult(ctx, params, result.reason);
      return accepted;
    }
    if (ctx.isSteppedCommandAuthorityCurrent?.() === false) return false;
    accepted = recordAcceptedSteppedLoadCommand(ctx, {
      ...params,
      commandTransport: result.transport,
    });
    return accepted;
  } catch (error) {
    if (isHomeyRequestTimeout(error)) {
      // Authority first, exactly as the accepted path does above: a command that
      // no longer owns the claim must not stamp bookkeeping the successor owns.
      // Checked as its own step, not folded into the condition above — a
      // superseded write is still an UNKNOWN one, and falling through to the
      // failure branch would log it as the definite failure it is not.
      if (ctx.isSteppedCommandAuthorityCurrent?.() === false) return false;
      accepted = recordUnacknowledgedSteppedLoadCommand(ctx, {
        ...params,
        err: error,
        // Only the native branch can throw this: the Flow branch catches
        // everything and reports its outcome as a typed result instead.
        commandTransport: 'native_capability',
        unacknowledgedReason: 'command_request_timed_out',
      });
      return accepted;
    }
    logger.error({
      event: 'stepped_load_command_failed',
      reasonCode: 'command_failed',
      deviceId: action.id,
      deviceName: action.name,
      desiredStepId: desiredStep.id,
      planningPowerW: desiredStep.planningPowerW,
    });
    logger.error({
      event: 'executor_stepped_error',
      msg: `Failed to request stepped-load command for ${action.name}`,
      err: error,
    });
    return false;
  } finally {
    ctx.steppedCommandClaim.release(
      action.id,
      ctx.steppedCommandOwner,
      desiredStep.id,
      accepted,
    );
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
