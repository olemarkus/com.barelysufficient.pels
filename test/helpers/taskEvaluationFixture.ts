import {
  buildDeferredObjectiveDiagnostics,
  LIVE_LANE,
  type TaskEvaluationLane,
  type TaskEvaluationReaders,
  type TaskEvaluationSnapshot,
} from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import { PriorityAllocationTracker } from '../../lib/objectives/deferredObjectives/priorityAllocation';

// The flat shape specs build a cycle from: its snapshot and readers together,
// with the lane's tracker and a preview candidate as optional knobs. Runtime keeps
// the four apart; a fixture is easier to read and override in one literal.
export type TaskEvaluationFixture = TaskEvaluationSnapshot & TaskEvaluationReaders & {
  // Omitted: a tracker that has seen nothing, as on a fresh runtime.
  priorityAllocationTracker?: PriorityAllocationTracker;
  // Set: evaluate as the preview of this candidate rather than a live lane.
  forceFreshDeviceId?: string;
};

const splitFixture = (
  fixture: TaskEvaluationFixture,
): [TaskEvaluationSnapshot, TaskEvaluationReaders, PriorityAllocationTracker, TaskEvaluationLane] => {
  const {
    buildPriceHorizon,
    getPrioritiesForDevices,
    resolveDeviceExclusion,
    getStallClassification,
    getDeliveredEnergyKWh,
    isReservationSuppressed,
    priorityAllocationTracker,
    forceFreshDeviceId,
    ...snapshot
  } = fixture;
  return [
    snapshot,
    {
      buildPriceHorizon,
      getPrioritiesForDevices,
      resolveDeviceExclusion,
      getStallClassification,
      getDeliveredEnergyKWh,
      isReservationSuppressed,
    },
    priorityAllocationTracker ?? new PriorityAllocationTracker(),
    forceFreshDeviceId === undefined ? LIVE_LANE : { kind: 'preview', candidateDeviceId: forceFreshDeviceId },
  ];
};

export const buildFixtureDiagnostics = (
  fixture: TaskEvaluationFixture,
): ReturnType<typeof buildDeferredObjectiveDiagnostics> => buildDeferredObjectiveDiagnostics(...splitFixture(fixture));
