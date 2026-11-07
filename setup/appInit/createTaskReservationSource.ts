import type { InitializedAppContext } from '../../lib/app/appContext';
import type { TaskEvaluationSource } from '../../lib/objectives/deferredObjectives';
import { ObjectiveTaskReservationSource } from '../../lib/objectives/deferredObjectives/taskReservationSource';
import { createTrustedDeferredObjectiveSettingsReader } from '../../lib/objectives/deferredObjectives/objectiveStore';
import type { TaskReservationSource } from '../../lib/ports/taskReservations';
import { toPlanDevice } from './toPlanDevice';

/** Construct the objective owner's reservation read without entering battery projection. */
export function createTaskReservationSource(
  ctx: InitializedAppContext,
  taskEvaluationSource: TaskEvaluationSource,
): TaskReservationSource {
  return new ObjectiveTaskReservationSource(
    taskEvaluationSource,
    createTrustedDeferredObjectiveSettingsReader(ctx.homey.settings),
    () => ctx.getPlanInputSnapshot(),
    (device) => toPlanDevice(ctx, device),
  );
}
