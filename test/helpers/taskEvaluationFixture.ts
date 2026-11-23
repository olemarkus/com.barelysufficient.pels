import {
  buildDeferredObjectiveDiagnostics,
  LIVE_LANE,
  type TaskEvaluationLane,
  type TaskEvaluationReaders,
  type TaskEvaluationSnapshot,
} from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import { TaskAllocationRoster } from '../../lib/objectives/deferredObjectives/taskAllocationRoster';
import { resolveObjectiveDeviceInputs, type ObjectiveDeviceInput, type ObjectiveDeviceSource } from '../../lib/objectives/types';

// The flat shape specs build a cycle from: its snapshot and readers together,
// with the shared roster owner and a preview candidate as optional knobs. Runtime keeps
// the snapshot, readers and lane apart; a fixture is easier to read and override in one literal.
export type TaskEvaluationFixture = Omit<TaskEvaluationSnapshot, 'allocationRoster' | 'devices'>
& Omit<TaskEvaluationReaders, 'prefersContinuousCharging'> & {
  devices: readonly (ObjectiveDeviceInput
    | (ObjectiveDeviceSource & Pick<ObjectiveDeviceInput, 'currentDrawKw' | 'thermalDirection'>))[];
  prefersContinuousCharging?: TaskEvaluationReaders['prefersContinuousCharging'];
  // Omitted: a roster that has seen nothing, as on a fresh runtime.
  allocationRosterOwner?: TaskAllocationRoster;
  // Set: evaluate as the preview of this candidate rather than a live lane.
  forceFreshDeviceId?: string;
};

const splitFixture = (
  fixture: TaskEvaluationFixture,
): [TaskEvaluationSnapshot, TaskEvaluationReaders, TaskEvaluationLane] => {
  const {
    prefersContinuousCharging = () => false,
    buildPriceHorizon,
    getPrioritiesForDevices,
    resolveDeviceExclusion,
    getStallClassification,
    hasObservedTask,
    getDeliveredEnergyKWh,
    isReservationSuppressed,
    getEnergyIdleState,
    allocationRosterOwner,
    forceFreshDeviceId,
    devices,
    ...snapshot
  } = fixture;
  const objectiveDevices = devices.flatMap((device) => 'energyIdleCapable' in device
    ? [device] : resolveObjectiveDeviceInputs([device], () => device.thermalDirection));
  const owner = allocationRosterOwner ?? new TaskAllocationRoster(() => new Date(snapshot.nowMs));
  if (forceFreshDeviceId === undefined) {
    owner.observe(objectiveDevices, snapshot.nowMs, (deviceId) => resolveDeviceExclusion(deviceId) !== null);
    owner.retainObjectiveDeviceIds(new Set(Object.keys(snapshot.settings.objectivesByDeviceId)));
  }
  return [
    { ...snapshot, devices: objectiveDevices, allocationRoster: owner.read(snapshot.nowMs) },
    {
      prefersContinuousCharging,
      buildPriceHorizon,
      getPrioritiesForDevices,
      resolveDeviceExclusion,
      getStallClassification,
      hasObservedTask,
      getDeliveredEnergyKWh,
      isReservationSuppressed,
      getEnergyIdleState,
    },
    forceFreshDeviceId === undefined ? LIVE_LANE : { kind: 'preview', candidateDeviceId: forceFreshDeviceId },
  ];
};

export const buildFixtureDiagnostics = (
  fixture: TaskEvaluationFixture,
): ReturnType<typeof buildDeferredObjectiveDiagnostics> => buildDeferredObjectiveDiagnostics(...splitFixture(fixture));

/** Exercise a production evaluation lane with the same resolved household fixture. */
export const buildFixtureDiagnosticsForLane = (
  fixture: TaskEvaluationFixture,
  lane: TaskEvaluationLane,
): ReturnType<typeof buildDeferredObjectiveDiagnostics> => {
  const [snapshot, readers] = splitFixture(fixture);
  return buildDeferredObjectiveDiagnostics(snapshot, readers, lane);
};
