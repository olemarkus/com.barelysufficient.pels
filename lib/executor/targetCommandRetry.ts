/**
 * Send / retry / skip for one temperature-target command, and the attempt
 * bookkeeping that backs it off.
 *
 * Executor-owned: this is command materialization — "has my write landed, and
 * when may I re-issue it?" — not a planner decision about desired state
 * (`lib/AGENTS.md` § Layer boundaries). It moved here from
 * `lib/plan/planTargetControl.ts`, which keeps the plan-lifecycle half
 * (decoration, pruning, observed synchronization). No file imported both
 * halves, so the split is along a seam the call graph already had.
 *
 * The `PendingTargetCommandState` records still live on the shared
 * `PlanEngineState`; narrowing that to an executor-owned store is the next
 * stage of the planner/executor seam train, and this module is deliberately
 * written against `Pick<PlanEngineState, 'pendingTargetCommands'>` so that
 * narrowing is a type change here rather than a rewrite.
 *
 * **YOU ARE NOT THE ONLY WRITER OF THAT RECORD, AND THAT IS THE TRAP.** This
 * module creates and replaces entries; `lib/plan/planTargetControl.ts` DELETES
 * them (`prunePendingTargetCommandsForPlan`, and the missing-device path) and
 * mutates their observation fields in place. So the backoff ladder is a policy
 * spanning two layers: `retryCount` is read here to pick the next delay from
 * `TARGET_COMMAND_RETRY_DELAYS_MS`, while a planner rebuild whose
 * `plannedTarget` no longer equals `pending.desired` deletes the record and
 * silently rewinds that ladder to zero. That is pre-existing behaviour, not
 * something this split introduced — but before the split it was one file's
 * problem, and no test pins it. Whoever moves the storage owns reconciling it;
 * do not discover it by breaking it.
 *
 * The two `record*Attempt` functions are ~35 lines of near-duplicate, differing
 * only in `nextRetryAtMs`, `status`, and `lastWaitingLogAtMs`. They are carried
 * over verbatim on purpose: this was a pure move, and collapsing them into one
 * `status`-parameterized builder in the same change would have hidden a
 * behaviour question inside a relocation. Collapse them in a follow-up.
 */
import { TARGET_COMMAND_RETRY_DELAYS_MS } from '../plan/planConstants';
import type { PendingTargetCommandState, PlanEngineState } from '../plan/planState';
import { resolveControlCommandConfirmationMs } from '../observer/controlCommandConfirmation';

type PendingTargetStore = Pick<PlanEngineState, 'pendingTargetCommands'>;

type PendingTargetDecision =
  | { type: 'send' }
  | { type: 'retry'; pending: PendingTargetCommandState }
  | { type: 'skip'; pending: PendingTargetCommandState; remainingMs: number };

export function getPendingTargetCommandDecision(params: {
  state: PendingTargetStore;
  deviceId: string;
  desired: number;
  nowMs: number;
}): PendingTargetDecision {
  const { state, deviceId, desired, nowMs } = params;
  const pending = state.pendingTargetCommands[deviceId];
  if (!pending || pending.target !== 'temperature' || pending.desired !== desired) {
    return { type: 'send' };
  }
  if (nowMs >= pending.nextRetryAtMs) {
    return { type: 'retry', pending };
  }
  return {
    type: 'skip',
    pending,
    remainingMs: pending.nextRetryAtMs - nowMs,
  };
}

export function recordPendingTargetCommandAttempt(params: {
  state: PendingTargetStore;
  deviceId: string;
  target: 'temperature';
  desired: number;
  nowMs: number;
  observedValue?: unknown;
  communicationModel?: 'local' | 'cloud';
}): PendingTargetCommandState {
  const {
    state,
    deviceId,
    target,
    desired,
    nowMs,
    observedValue,
    communicationModel,
  } = params;
  const previous = state.pendingTargetCommands[deviceId];
  const isRetry = previous?.target === 'temperature' && previous.desired === desired;
  const retryCount = isRetry ? previous.retryCount + 1 : 0;
  const entry: PendingTargetCommandState = {
    target,
    desired,
    startedMs: isRetry ? previous.startedMs : nowMs,
    pendingMs: isRetry ? previous.pendingMs : resolveControlCommandConfirmationMs(communicationModel ?? 'local'),
    lastAttemptMs: nowMs,
    retryCount,
    nextRetryAtMs: nowMs + (isRetry
      ? getTargetCommandRetryDelayMs(retryCount)
      : resolveControlCommandConfirmationMs(communicationModel ?? 'local')),
    status: 'waiting_confirmation',
    lastObservedValue: resolvePendingTargetObservedValue({
      isRetry,
      observedValue,
      previous,
    }),
    lastObservedSource: isRetry ? previous?.lastObservedSource : undefined,
    lastObservedAtMs: isRetry ? previous?.lastObservedAtMs : undefined,
    lastWaitingLogAtMs: isRetry ? previous?.lastWaitingLogAtMs : undefined,
  };
  // eslint-disable-next-line functional/immutable-data -- Executor-owned pending-command store owns this entry.
  state.pendingTargetCommands[deviceId] = entry;
  return entry;
}

export function recordFailedPendingTargetCommandAttempt(params: {
  state: PendingTargetStore;
  deviceId: string;
  target: 'temperature';
  desired: number;
  nowMs: number;
  observedValue?: unknown;
  communicationModel?: 'local' | 'cloud';
}): PendingTargetCommandState {
  const {
    state,
    deviceId,
    target,
    desired,
    nowMs,
    observedValue,
    communicationModel,
  } = params;
  const previous = state.pendingTargetCommands[deviceId];
  const isRetry = previous?.target === 'temperature' && previous.desired === desired;
  const retryCount = isRetry ? previous.retryCount + 1 : 0;
  const entry: PendingTargetCommandState = {
    target,
    desired,
    startedMs: isRetry ? previous.startedMs : nowMs,
    pendingMs: isRetry ? previous.pendingMs : resolveControlCommandConfirmationMs(communicationModel ?? 'local'),
    lastAttemptMs: nowMs,
    retryCount,
    nextRetryAtMs: nowMs + getTargetCommandRetryDelayMs(retryCount),
    status: 'temporary_unavailable',
    lastObservedValue: resolvePendingTargetObservedValue({
      isRetry,
      observedValue,
      previous,
    }),
    lastObservedSource: isRetry ? previous?.lastObservedSource : undefined,
    lastObservedAtMs: isRetry ? previous?.lastObservedAtMs : undefined,
    lastWaitingLogAtMs: undefined,
  };
  // eslint-disable-next-line functional/immutable-data -- Executor-owned pending-command store owns this entry.
  state.pendingTargetCommands[deviceId] = entry;
  return entry;
}

function getTargetCommandRetryDelayMs(retryCount: number): number {
  const index = Math.min(retryCount, TARGET_COMMAND_RETRY_DELAYS_MS.length - 1);
  // The ladder is a fixed const tuple and the index is clamped to its last rung, so the
  // lookup can only miss for a negative retry count — which reads as "no retry yet", the
  // first rung.
  return TARGET_COMMAND_RETRY_DELAYS_MS[index] ?? TARGET_COMMAND_RETRY_DELAYS_MS[0];
}

function resolvePendingTargetObservedValue(params: {
  isRetry: boolean;
  observedValue: unknown;
  previous?: PendingTargetCommandState;
}): unknown {
  const { isRetry, observedValue, previous } = params;
  if (observedValue !== undefined) return observedValue;
  return isRetry ? previous?.lastObservedValue : undefined;
}
