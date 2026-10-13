import {
  getSteppedLoadStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import type { SteppedLoadStep } from '../../packages/contracts/src/types';
import { isRequestedStepMaterialized } from './steppedLoadActuation';
import type {
  ExecutableSteppedLoadDevice,
  ExecutableSteppedLoadIntent,
  ExecutableSteppedLoadTransition,
} from './executablePlan';
import {
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { SteppedLoadStepRequestResult, SteppedLoadStepRequestTransport } from '../ports/steppedLoadWrite';
import { getDebugEmitter, getLogger } from '../logging/logger';
import { isHomeyRequestTimeout } from '../utils/errorUtils';
import { isHeldByLifecycleLane, type ExecutorCommandContext } from './executorCommandContext';

const logger = getLogger('executor/stepped-load');
/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

export const isSteppedLoadStepCommandRedundant = (
  action: ExecutableSteppedLoadDevice,
  commandStepId: string,
): boolean => {
  const { transition } = action.intent;
  const needsStepPreparation = transition?.transitionPhase === 'step_preparation'
    && transition.commandStepId === commandStepId;
  const restoreStepNeedsMaterialization = transition?.effectiveTransition === 'restore_from_off_at_low'
    && !isRequestedStepMaterialized(action.stepActuation);
  return commandStepId === action.current.stepId
    && !needsStepPreparation
    && !restoreStepNeedsMaterialization;
};

export const maybeLogSteppedLoadCommandPendingSkip = (
  intent: ExecutableSteppedLoadIntent,
  commandStepId: string,
): boolean => {
  const sameDesiredStepPendingState = intent.matchingCommandAttempt;
  if (sameDesiredStepPendingState?.status === 'awaiting_confirmation') {
    logSteppedLoadCommandSkip(
      intent,
      'waiting_for_confirmation',
      `Capacity: skip stepped-load command for ${intent.name}, awaiting confirmation of ${commandStepId}`,
      { desiredStepId: commandStepId, plannedDesiredStepId: intent.desired.plannedStepId ?? null },
    );
    return true;
  }
  if (sameDesiredStepPendingState?.status === 'retry_backoff') {
    logSteppedLoadCommandSkip(
      intent,
      'retry_backoff',
      `Capacity: skip stepped-load command for ${intent.name}, retry backoff for ${commandStepId} remains active`,
      {
        desiredStepId: commandStepId,
        nextRetryAtMs: intent.nextStepCommandRetryAtMs ?? null,
        retryCount: intent.stepCommandRetryCount,
      },
    );
    return true;
  }
  return false;
};

export const logSteppedLoadCommandSkip = (
  intent: ExecutableSteppedLoadIntent,
  reasonCode:
    | 'missing_step'
    | 'waiting_for_confirmation'
    | 'retry_backoff'
    | 'command_unavailable'
    | 'not_below_reported_step',
  logMessage: string,
  fields: Record<string, unknown>,
): false => {
  emitExecutorDebug({
    event: 'stepped_load_command_skipped',
    reasonCode,
    deviceId: intent.id,
    deviceName: intent.name,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    logContext: 'capacity',
    ...fields,
  });
  emitExecutorDebug({ event: 'executor_stepped_log_debug', msg: logMessage });
  return false;
};

/**
 * How a step command is issued and accounted. `force` bypasses the redundant-step
 * and pending-command dampening: the post-activation reassertion uses it for a
 * step that already reads as reached, and a lifecycle release uses it after an
 * accepted opposing claim released.
 */
export type SteppedCommandOptions = {
  recordPlanActuation?: boolean;
  force?: boolean;
  preserveMaterializedConfirmation?: boolean;
  commandPurpose?: 'post_activation_step';
};

/**
 * Which channel left a command unacknowledged — both mean the same thing, and
 * each names its transport (`commandTransportFor`).
 */
type UnacknowledgedReason = 'command_request_timed_out' | 'flow_trigger_timeout';

const commandTransportFor = (reason: UnacknowledgedReason): SteppedLoadStepRequestTransport => (
  reason === 'flow_trigger_timeout' ? 'flow' : 'native_capability'
);

const markAcceptedSteppedLoadCommand = (
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  desiredStep: SteppedLoadStep,
  now: number,
  options: SteppedCommandOptions,
): void => {
  if (
    options.preserveMaterializedConfirmation === true
    && isRequestedStepMaterialized(action.stepActuation)
  ) return;
  if (action.intent.transition?.effectiveTransition === 'initialize_unknown_step_at_low') {
    ctx.markSteppedLoadDesiredStepIssued({
      deviceId: action.intent.id,
      desiredStepId: desiredStep.id,
      issuedAtMs: now,
      confirmationPolicy: 'assume_applied',
    });
    return;
  }
  ctx.markSteppedLoadDesiredStepIssued({
    deviceId: action.intent.id,
    desiredStepId: desiredStep.id,
    previousStepId: action.intent.previousStepId,
    issuedAtMs: now,
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
  action: ExecutableSteppedLoadDevice,
  desiredStep: SteppedLoadStep,
  options: SteppedCommandOptions,
  commandTransport: SteppedLoadStepRequestTransport | undefined,
): void => {
  const { transition, previousStepId } = action.intent;
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
    deviceId: action.intent.id,
    deviceName: action.intent.name,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    previousStepId: previousStepId ?? null,
    desiredStepId: desiredStep.id,
    planningPowerW: desiredStep.planningPowerW,
    ...transitionFields,
    ...(commandTransport ? { commandTransport } : {}),
  });
};

const recordAcceptedSteppedLoadPlanActuation = (
  ctx: ExecutorCommandContext,
  intent: ExecutableSteppedLoadIntent,
  desiredStep: SteppedLoadStep,
  now: number,
  options: SteppedCommandOptions,
  // An unacknowledged write still stamps the cooldown CLOCKS — see the caller
  // for why that is the conservative reading in both directions — but it must
  // not open a starvation activation attempt, because that is a claim about
  // what the DEVICE started doing, and nothing here saw the device do anything.
  recordActivationAttempt: boolean,
): void => {
  if (options.recordPlanActuation === false) return;
  const effectiveTransition = intent.transition?.effectiveTransition;
  if (effectiveTransition === 'step_down_while_on') {
    ctx.recordShedActuation(intent.id, intent.name, now);
    return;
  }
  if (
    effectiveTransition !== 'step_up_while_on'
    && effectiveTransition !== 'restore_from_off_at_low'
    && !isSteppedLoadRestoreStepIncrease(intent, desiredStep.id)
  ) return;
  ctx.recordRestoreActuation(intent.id, intent.name, now);
  if (!recordActivationAttempt) return;
  ctx.recordActivationAttemptStarted(intent.id, intent.name, now);
};

const isSteppedLoadRestoreStepIncrease = (
  intent: ExecutableSteppedLoadIntent,
  desiredStepId: string,
): boolean => {
  const { previousStepId } = intent;
  // Load-bearing, not cosmetic: this gates `recordRestoreActuation`, which
  // stamps the restore cooldown. A shed device observed BELOW its decided rung
  // is commanded up, so the power comparison alone would read that as a restore.
  if (intent.plannedShedTarget !== undefined || !previousStepId) return false;
  const previousStep = getSteppedLoadStep(intent.steppedLoadProfile, previousStepId);
  const desiredStep = getSteppedLoadStep(intent.steppedLoadProfile, desiredStepId);
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
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  desiredStep: SteppedLoadStep,
  now: number,
): void => {
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
  if (action.intent.transition?.effectiveTransition === 'initialize_unknown_step_at_low') return;
  ctx.markSteppedLoadDesiredStepIssued({
    deviceId: action.intent.id,
    desiredStepId: desiredStep.id,
    previousStepId: action.intent.previousStepId,
    issuedAtMs: now,
    unacknowledged: true,
  });
};

const logUnacknowledgedSteppedLoadCommand = (
  action: ExecutableSteppedLoadDevice,
  desiredStep: SteppedLoadStep,
  options: SteppedCommandOptions,
  unacknowledgedReason: UnacknowledgedReason,
  err: unknown,
): void => {
  const { transition, previousStepId } = action.intent;
  logger.warn({
    event: 'stepped_load_command_outcome_unknown',
    reasonCode: unacknowledgedReason,
    deviceId: action.intent.id,
    deviceName: action.intent.name,
    targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    previousStepId: previousStepId ?? null,
    desiredStepId: desiredStep.id,
    planningPowerW: desiredStep.planningPowerW,
    commandPurpose: resolveCommandPurpose(transition, options.commandPurpose),
    // The direction is load-bearing here, not decoration: it selects which
    // cooldown clock the unacknowledged write stamped.
    effectiveTransition: transition?.effectiveTransition ?? 'steady',
    plannedDesiredStepId: transition?.plannedDesiredStepId ?? desiredStep.id,
    commandTransport: commandTransportFor(unacknowledgedReason),
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
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  desiredStep: SteppedLoadStep,
  now: number,
  options: SteppedCommandOptions,
  reason: 'flow_trigger_timeout' | undefined,
): boolean => {
  const { intent } = action;
  if (reason !== 'flow_trigger_timeout') {
    return logSteppedLoadCommandSkip(
      intent,
      'command_unavailable',
      `Capacity: skip stepped-load command for ${intent.name}, no command transport for desired step ${desiredStep.id}`,
      { desiredStepId: desiredStep.id },
    );
  }
  if (!ctx.isAuthorityCurrent()) return false;
  return recordUnacknowledgedSteppedLoadCommand(ctx, action, desiredStep, now, options, reason, undefined);
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
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  desiredStep: SteppedLoadStep,
  now: number,
  options: SteppedCommandOptions,
  unacknowledgedReason: UnacknowledgedReason,
  err: unknown,
): boolean => {
  markUnacknowledgedSteppedLoadCommand(ctx, action, desiredStep, now);
  logUnacknowledgedSteppedLoadCommand(action, desiredStep, options, unacknowledgedReason, err);
  recordAcceptedSteppedLoadPlanActuation(ctx, action.intent, desiredStep, now, options, false);
  return true;
};

const recordAcceptedSteppedLoadCommand = (
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  desiredStep: SteppedLoadStep,
  now: number,
  options: SteppedCommandOptions,
  commandTransport: SteppedLoadStepRequestTransport | undefined,
): boolean => {
  markAcceptedSteppedLoadCommand(ctx, action, desiredStep, now, options);
  logAcceptedSteppedLoadCommand(action, desiredStep, options, commandTransport);
  recordAcceptedSteppedLoadPlanActuation(ctx, action.intent, desiredStep, now, options, true);
  return true;
};

/**
 * The step write, through the single actuator seam. The not-requested arm keeps
 * the outcome's `reason` — dropping it collapsed an unacknowledged Flow trigger
 * into an ordinary "no transport" skip.
 */
const requestSteppedLoadStep = async (
  ctx: ExecutorCommandContext,
  intent: ExecutableSteppedLoadIntent,
  desiredStep: SteppedLoadStep,
): Promise<SteppedLoadStepRequestResult> => {
  const outcome = await ctx.actuator.apply({
    kind: 'step',
    deviceId: intent.id,
    profile: intent.steppedLoadProfile,
    desiredStepId: desiredStep.id,
    planningPowerW: desiredStep.planningPowerW,
    planningCurrentA: resolvePlanningCurrentA(desiredStep),
    previousStepId: intent.previousStepId,
  });
  if (outcome.requested && outcome.kind === 'step') return outcome.steppedResult;
  // A step's only not-requested reason; a storage claim's is never a step's.
  const reason = !outcome.requested && outcome.reason === 'flow_trigger_timeout' ? outcome.reason : undefined;
  return { requested: false, ...(reason ? { reason } : {}) };
};

/** One step command for `action` at `desiredStep`, issued and accounted as `options` says. */
export const executeSteppedLoadCommand = async (
  ctx: ExecutorCommandContext,
  action: ExecutableSteppedLoadDevice,
  desiredStep: SteppedLoadStep,
  options: SteppedCommandOptions,
): Promise<boolean> => {
  const { intent } = action;
  const now = Date.now();
  if (isHeldByLifecycleLane(ctx, intent.id)) return false;
  if (!ctx.steppedCommandClaim.acquire(
    intent.id,
    ctx.owner,
    desiredStep.id,
    ctx.onSteppedCommandClaimReleased,
  )) return false;
  let accepted = false;
  try {
    const result = await requestSteppedLoadStep(ctx, intent, desiredStep);
    if (!result.requested) {
      accepted = handleUnrequestedSteppedLoadResult(ctx, action, desiredStep, now, options, result.reason);
      return accepted;
    }
    if (!ctx.isAuthorityCurrent()) return false;
    accepted = recordAcceptedSteppedLoadCommand(ctx, action, desiredStep, now, options, result.transport);
    return accepted;
  } catch (error) {
    if (isHomeyRequestTimeout(error)) {
      // Authority first, exactly as the accepted path does above: a command that
      // no longer owns the claim must not stamp bookkeeping the successor owns.
      // Checked as its own step, not folded into the condition above — a
      // superseded write is still an UNKNOWN one, and falling through to the
      // failure branch would log it as the definite failure it is not.
      if (!ctx.isAuthorityCurrent()) return false;
      // Only the native branch can throw this: the Flow branch catches
      // everything and reports its outcome as a typed result instead.
      accepted = recordUnacknowledgedSteppedLoadCommand(
        ctx, action, desiredStep, now, options, 'command_request_timed_out', error,
      );
      return accepted;
    }
    logger.error({
      event: 'stepped_load_command_failed',
      reasonCode: 'command_failed',
      deviceId: intent.id,
      deviceName: intent.name,
      desiredStepId: desiredStep.id,
      planningPowerW: desiredStep.planningPowerW,
    });
    logger.error({
      event: 'executor_stepped_error',
      msg: `Failed to request stepped-load command for ${intent.name}`,
      err: error,
    });
    return false;
  } finally {
    ctx.steppedCommandClaim.release(
      intent.id,
      ctx.owner,
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
