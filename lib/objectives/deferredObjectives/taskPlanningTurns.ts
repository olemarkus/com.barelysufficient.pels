import type { ContextualDeferredObjective, OrderedDeferredObjective } from './priorityAllocation';
import type { TaskEvaluationReport, TaskEvaluationSnapshot } from './taskEvaluationCoordinator';
import { resolveObjectiveProgressDirectionRead } from '../types';
import { resolveDeadlineBoundFrozenReadInputs } from './frozenDiagnostic';
import type { TaskEvaluationLane } from './taskEvaluationCoordinator';
import type { TaskEvaluation } from './taskEvaluation';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';
import { isObjectiveProgressSatisfied, type DeferredObjectiveProgressResolution } from './diagnosticProgress';
import { isPastHourSettleMark, SCHEDULE_SETTLE_OFFSET_MS } from './settleWindow';

const HOUR_MS = 3_600_000;

export type TaskAllocationMode = 'ordinary' | 'fresh' | 'serve' | 'serve_idle' | 'wait';

export const resolveTaskAllocationMode = (
  bounded: boolean, selected: boolean, contextChanged: boolean, forceFresh: boolean,
): TaskAllocationMode => {
  if (!bounded) return forceFresh ? 'fresh' : 'ordinary';
  if (selected) return 'fresh';
  return contextChanged ? 'wait' : 'serve';
};

export const taskReplanRequested = (
  allocation: TaskAllocationMode, hasFrozen: boolean, nowMs: number,
): boolean => {
  if (allocation === 'fresh') return true;
  return allocation === 'ordinary' && (!hasFrozen || isPastHourSettleMark(nowMs));
};


export const isFreshTaskEvaluation = (evaluation: TaskEvaluation): boolean => (
  evaluation.planning.kind === 'allocated' && evaluation.planning.plan.frozenRead !== true
);

export const isSelectedFreshTurn = (
  lane: TaskEvaluationLane, selected: ReadonlySet<string>, evaluation: TaskEvaluation,
): boolean => lane.kind === 'scheduled' && selected.has(evaluation.deviceId) && isFreshTaskEvaluation(evaluation);

export const allocationContextChanged = (
  held: string | undefined, current: string, hasReservations: boolean,
): boolean => held === undefined ? hasReservations : held !== current;

/**
 * Revisions saved before planning turns list each higher claim as a
 * `[device, topology]` pair. Such a plan was allocated against those claims, so
 * it stays compatible while the roster ahead of it is the one it was planned for.
 */
const isCompatibleLegacyContext = (held: string | undefined, rosterSignature: string): boolean => {
  if (held === undefined) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(held); } catch { return false; }
  if (!Array.isArray(parsed) || parsed.length !== 2 || !Array.isArray(parsed[1])) return false;
  return parsed[0] === rosterSignature
    && parsed[1].every((claim) => Array.isArray(claim) && claim.length === 2);
};

/**
 * What a queue turn records when it could not allocate in `context` and served
 * the saved commitment instead. It never equals the context, so the commitment
 * still counts as planned elsewhere: the queue keeps its ticket and the next
 * fresh allocation replaces it.
 */
export const reviewedContextSignature = (context: string): string => JSON.stringify(['reviewed', context]);

/** A changed context that the task's own turn has already reviewed needs no hold. */
const isReviewedContext = (held: string | undefined, current: string): boolean => (
  held === reviewedContextSignature(current)
);

/**
 * A commitment planned for another context is still served when its roster is
 * the one a pre-queue revision was planned for, or when its own turn reviewed
 * it in this context and could not replan.
 */
export const servesSavedCommitment = (
  held: string | undefined, current: string, rosterSignature: string,
): boolean => isCompatibleLegacyContext(held, rosterSignature) || isReviewedContext(held, current);

/** Whether the saved context differs from the current one, and whether that needs the task's turn. */
export const readAllocationContext = (
  bounded: boolean, held: string | undefined, current: string, rosterSignature: string, hasReservations: boolean,
): { changed: boolean; needsTurn: boolean } => {
  const changed = allocationContextChanged(held, current, hasReservations);
  return { changed, needsTurn: changed && !(bounded && servesSavedCommitment(held, current, rosterSignature)) };
};

/** The task's own turn, in a changed context, ended on its saved commitment. */
export const isReviewedTurn = (
  selected: ReadonlySet<string>, contextChanged: boolean, evaluation: TaskEvaluation,
): boolean => selected.has(evaluation.deviceId) && contextChanged
  && evaluation.planning.kind === 'allocated' && evaluation.planning.plan.frozenRead === true;

/**
 * Frozen and waiting reports cannot certify that a changed context was planned:
 * they keep the saved signature. The exception is the task's own turn that found
 * no fresh allocation possible (a price or step gap) and served its commitment.
 * Holding the device for a plan that cannot be made would keep it off for the
 * length of the gap, so that turn records the context it reviewed.
 */
export const resolveReportedContext = (
  keepsSaved: boolean, reviewed: boolean, saved: string | undefined, current: string,
): Pick<DeferredObjectiveDiagnostic, 'allocationContextSignature' | 'contextReviewed'> => {
  if (reviewed) return { allocationContextSignature: reviewedContextSignature(current), contextReviewed: true };
  return { allocationContextSignature: keepsSaved ? saved : current };
};

export const shouldWaitForPlanningTurn = (
  allocation: TaskAllocationMode, hasFrozen: boolean,
  snapshot: TaskEvaluationSnapshot, progress: DeferredObjectiveProgressResolution,
): boolean => allocation === 'wait' && hasFrozen
  && snapshot.priceOptimizationEnabled && !isObjectiveProgressSatisfied(progress);

export const hasPlanningCommitment = (
  task: OrderedDeferredObjective,
  snapshot: TaskEvaluationSnapshot,
): boolean => resolveDeadlineBoundFrozenReadInputs(
  task.deviceId, task.objective,
  resolveObjectiveProgressDirectionRead({
    objectiveKind: task.objective.kind, thermalDirection: task.device?.thermalDirection ?? 'unknown',
  }),
  snapshot.nowMs, snapshot.activePlans,
) !== null;

/** A restart keeps a compatible revision that already settled this generation. */
const hasSettledPlanningContext = (
  task: OrderedDeferredObjective, snapshot: TaskEvaluationSnapshot, context: string, generation: number,
): boolean => {
  const latest = snapshot.activePlans.plansByDeviceId[task.deviceId]?.latest;
  return latest?.allocationContextSignature === context
    && latest.revisedAtMs >= generation * HOUR_MS + SCHEDULE_SETTLE_OFFSET_MS
    && hasPlanningCommitment(task, snapshot);
};

/**
 * One home's allocation work queue. Initial tickets follow device priority;
 * edits retain their ticket's age and failed attempts retry at the tail.
 * The generation advances at :58 and survives :00 until every task has had a turn.
 */
export class TaskPlanningTurns {
  private readonly waiting = new Set<string>();
  private readonly attempted = new Map<string, { context: string; generation: number; completed: boolean }>();

  complete(selected: ReadonlySet<string>, reports: readonly TaskEvaluationReport[]): void {
    for (const deviceId of selected) {
      const result = reports.find(({ evaluation }) => evaluation.deviceId === deviceId)?.evaluation;
      const fresh = result !== undefined && isFreshTaskEvaluation(result);
      const attempt = this.attempted.get(deviceId);
      if (fresh && attempt) this.attempted.set(deviceId, {
        context: attempt.context, generation: attempt.generation, completed: true,
      });
    }
  }

  begin(ordered: readonly ContextualDeferredObjective[], snapshot: TaskEvaluationSnapshot): ReadonlySet<string> {
    const generation = Math.floor((snapshot.nowMs - SCHEDULE_SETTLE_OFFSET_MS) / HOUR_MS);
    const eligible = ordered.filter((task) => task.device && task.objective.deadlineAtMs > snapshot.nowMs);
    const liveIds = new Set(eligible.map((task) => task.deviceId));
    for (const deviceId of this.waiting) if (!liveIds.has(deviceId)) this.waiting.delete(deviceId);
    for (const deviceId of this.attempted.keys()) if (!liveIds.has(deviceId)) this.attempted.delete(deviceId);
    if (!snapshot.priceOptimizationEnabled) return new Set();
    for (const task of eligible) {
      const previous = this.attempted.get(task.deviceId);
      const context = task.planningContextSignature;
      if (!previous && hasSettledPlanningContext(task, snapshot, context, generation)) {
        this.attempted.set(task.deviceId, { context, generation, completed: true });
        continue;
      }
      if (!previous?.completed || previous.generation !== generation || previous.context !== context
        || !hasPlanningCommitment(task, snapshot)) this.waiting.add(task.deviceId);
    }
    const nextDeviceId = this.waiting.values().next().value;
    const selected = eligible.find((task) => task.deviceId === nextDeviceId);
    if (selected === undefined) return new Set();
    const { deviceId } = selected;
    this.waiting.delete(deviceId);
    this.attempted.set(deviceId, {
      context: selected.planningContextSignature,
      generation, completed: false,
    });
    return new Set([deviceId]);
  }
}
