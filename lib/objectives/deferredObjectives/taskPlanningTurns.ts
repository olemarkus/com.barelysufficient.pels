import type { OrderedDeferredObjective } from './priorityAllocation';
import { buildAllocationContextSignature } from './priorityAllocation';
import type { DeferredObjectiveActivePlansV2 } from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { TaskEvaluationReport, TaskEvaluationSnapshot } from './taskEvaluationCoordinator';
import { resolveObjectiveProgressDirectionRead } from '../types';
import { resolveDeadlineBoundFrozenReadInputs } from './frozenDiagnostic';
import type { TaskEvaluationLane } from './taskEvaluationCoordinator';
import type { TaskEvaluation } from './taskEvaluation';
import { isObjectiveProgressSatisfied, type DeferredObjectiveProgressResolution } from './diagnosticProgress';
import { isPastHourSettleMark, SCHEDULE_SETTLE_OFFSET_MS } from './settleWindow';

const HOUR_MS = 3_600_000;

export type TaskAllocationMode = 'ordinary' | 'fresh' | 'serve' | 'wait';

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

export const shouldWaitForPlanningTurn = (
  allocation: TaskAllocationMode, hasFrozen: boolean,
  snapshot: TaskEvaluationSnapshot, progress: DeferredObjectiveProgressResolution,
): boolean => allocation === 'wait' && hasFrozen
  && snapshot.priceOptimizationEnabled && !isObjectiveProgressSatisfied(progress);

/** Stable committed claims, never the live draw windows that narrow as time passes. */
export const planningTurnContext = (
  prefix: readonly OrderedDeferredObjective[],
  activePlans: DeferredObjectiveActivePlansV2,
): string => JSON.stringify([
  buildAllocationContextSignature(prefix),
  prefix.slice(0, -1).map(({ deviceId }) => {
    const plan = activePlans.plansByDeviceId[deviceId];
    return [deviceId, plan?.objectiveSignature, plan?.latest?.revision, plan?.latest?.revisedAtMs];
  }),
]);

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
      const fresh = result?.planning.kind === 'allocated' && result.planning.plan.frozenRead !== true;
      const attempt = this.attempted.get(deviceId);
      if (fresh && attempt) this.attempted.set(deviceId, {
        context: attempt.context, generation: attempt.generation, completed: true,
      });
    }
  }

  begin(ordered: readonly OrderedDeferredObjective[], snapshot: TaskEvaluationSnapshot): ReadonlySet<string> {
    const generation = Math.floor((snapshot.nowMs - SCHEDULE_SETTLE_OFFSET_MS) / HOUR_MS);
    const eligible = ordered.filter((task) => task.device && task.objective.deadlineAtMs > snapshot.nowMs);
    const liveIds = new Set(eligible.map((task) => task.deviceId));
    for (const deviceId of this.waiting) if (!liveIds.has(deviceId)) this.waiting.delete(deviceId);
    for (const deviceId of this.attempted.keys()) if (!liveIds.has(deviceId)) this.attempted.delete(deviceId);
    if (!snapshot.priceOptimizationEnabled) return new Set();
    for (const task of eligible) {
      const previous = this.attempted.get(task.deviceId);
      const context = planningTurnContext(ordered.slice(0, ordered.indexOf(task) + 1), snapshot.activePlans);
      if (!previous && hasSettledPlanningContext(task, snapshot, context, generation)) {
        this.attempted.set(task.deviceId, { context, generation, completed: true });
        continue;
      }
      if (!previous?.completed || previous.generation !== generation || previous.context !== context
        || !hasPlanningCommitment(task, snapshot)) this.waiting.add(task.deviceId);
    }
    const selected = this.waiting.values().next();
    if (selected.done) return new Set();
    const deviceId = selected.value;
    this.waiting.delete(deviceId);
    this.attempted.set(deviceId, {
      context: planningTurnContext(
        ordered.slice(0, ordered.findIndex((task) => task.deviceId === deviceId) + 1), snapshot.activePlans,
      ),
      generation, completed: false,
    });
    return new Set([deviceId]);
  }
}
