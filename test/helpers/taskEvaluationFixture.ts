import {
  buildDeferredObjectiveDiagnostics,
  LIVE_LANE,
  type TaskEvaluationLane,
  type TaskEvaluationReaders,
  type TaskEvaluationSnapshot,
} from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import { TaskAllocationRoster } from '../../lib/objectives/deferredObjectives/taskAllocationRoster';

// The flat shape specs build a cycle from: its snapshot and readers together,
// with the shared roster owner and a preview candidate as optional knobs. Runtime keeps
// the snapshot, readers and lane apart; a fixture is easier to read and override in one literal.
export type TaskEvaluationFixture = Omit<TaskEvaluationSnapshot, 'allocationRoster'> & TaskEvaluationReaders & {
  // Omitted: a roster that has seen nothing, as on a fresh runtime.
  allocationRosterOwner?: TaskAllocationRoster;
  // Set: evaluate as the preview of this candidate rather than a live lane.
  forceFreshDeviceId?: string;
};

const splitFixture = (
  fixture: TaskEvaluationFixture,
): [TaskEvaluationSnapshot, TaskEvaluationReaders, TaskEvaluationLane] => {
  const {
    buildPriceHorizon,
    getPrioritiesForDevices,
    resolveDeviceExclusion,
    getStallClassification,
    hasObservedTask,
    getDeliveredEnergyKWh,
    isReservationSuppressed,
    allocationRosterOwner,
    forceFreshDeviceId,
    ...snapshot
  } = fixture;
  const owner = allocationRosterOwner ?? new TaskAllocationRoster(() => new Date(snapshot.nowMs));
  if (forceFreshDeviceId === undefined) {
    owner.observe(snapshot.devices, snapshot.nowMs, (deviceId) => resolveDeviceExclusion(deviceId) !== null);
    owner.retainObjectiveDeviceIds(new Set(Object.keys(snapshot.settings.objectivesByDeviceId)));
  }
  return [
    { ...snapshot, allocationRoster: owner.read(snapshot.nowMs) },
    {
      buildPriceHorizon,
      getPrioritiesForDevices,
      resolveDeviceExclusion,
      getStallClassification,
      hasObservedTask,
      getDeliveredEnergyKWh,
      isReservationSuppressed,
    },
    forceFreshDeviceId === undefined ? LIVE_LANE : { kind: 'preview', candidateDeviceId: forceFreshDeviceId },
  ];
};

export const buildFixtureDiagnostics = (
  fixture: TaskEvaluationFixture,
): ReturnType<typeof buildDeferredObjectiveDiagnostics> => buildDeferredObjectiveDiagnostics(...splitFixture(fixture));
