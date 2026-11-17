import type { DeferredDecorationInput } from '../../packages/planner-types/src/deferredDecoration';
import type { DeferredObjectiveRoster } from '../../packages/contracts/src/deferredObjectiveSettings';
import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import {
  buildDeferredObjectiveTaskResults, buildTaskEvaluationSnapshot, type TaskEvaluationSource,
} from '../../lib/objectives/deferredObjectives/taskEvaluationCoordinator';
import { TaskPlanningTurns } from '../../lib/objectives/deferredObjectives/taskPlanningTurns';

/**
 * Admission fixtures establish their committed-schedule precondition through the
 * real lifecycle evaluator and recorder. Each preparation advances enough queue
 * turns for the supplied roster, using one fixed observation. Production still
 * runs one turn per lifecycle tick; the following decoration only serves it.
 */
export const createCommittedTaskPlanning = (original: TaskEvaluationSource) => {
  const recorder = new DeferredObjectiveActivePlanRecorder({
    load: () => original.getDeferredObjectiveActivePlans(), save: () => undefined,
  });
  const turns = new TaskPlanningTurns();
  const source: TaskEvaluationSource = {
    ...original, getDeferredObjectiveActivePlans: () => recorder.getActivePlansSnapshot(),
  };
  return {
    source,
    settle(input: DeferredDecorationInput, settings: DeferredObjectiveRoster): void {
      const lane = { kind: 'scheduled' as const, turns };
      for (let turn = 0; turn < Object.keys(settings.objectivesByDeviceId).length; turn += 1) {
        const snapshot = buildTaskEvaluationSnapshot(source, input.nowTs, input.devices, settings,
          input.dailyBudgetSnapshot, lane);
        const reports = buildDeferredObjectiveTaskResults(snapshot, source, lane);
        recorder.observe(reports.map(({ diagnostic }) => diagnostic), input.nowTs);
      }
    },
  };
};
