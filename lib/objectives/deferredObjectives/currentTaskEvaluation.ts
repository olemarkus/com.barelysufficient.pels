import type { ThermalDirection } from '../../../packages/contracts/src/types';
import type { DeferredObjectiveSettingsEntry } from '../../../packages/contracts/src/deferredObjectiveSettings';
import { resolveObjectiveTargetValue } from '../../../packages/shared-domain/src/deferredObjectiveValues';
import { resolveObjectiveDeviceInputs, type ObjectiveDeviceSource } from '../types';
import { completionFromEvaluation } from './completionDiagnostic';
import { resolveObjectiveProgress } from './diagnosticProgress';
import type { DeferredObjectiveStallClassificationReader } from './diagnosticTypes';
import type { DeliveredEnergyReader } from './energyDelivery';
import { inactiveTaskEvaluation, type TaskEvaluation } from './taskEvaluation';
import { buildUnallocatedTaskEvaluation } from './taskEvaluationProducer';

/** Undefined means history has not observed this exact obligation, including its kind. */
export type CurrentTaskEvaluationReader = (
  deviceId: string,
  objective: DeferredObjectiveSettingsEntry,
) => TaskEvaluation | undefined;

type CurrentTaskEvaluationDeps = {
  getDevices: () => ObjectiveDeviceSource[];
  getThermalDirection: (deviceId: string) => ThermalDirection;
  getDeliveredEnergyKWh: DeliveredEnergyReader;
  getStallClassification: DeferredObjectiveStallClassificationReader;
  hasObservedTask: (deviceId: string, objective: DeferredObjectiveSettingsEntry) => boolean;
};

/** Read completion for the old obligation without allocating or advancing the lifecycle. */
export const createCurrentTaskEvaluationReader = (deps: CurrentTaskEvaluationDeps): CurrentTaskEvaluationReader => (
  deviceId, objective,
) => {
  // A retained run may belong to an older obligation after an unreadable clear.
  // No exact history task means there is no completion snapshot to refresh.
  if (!deps.hasObservedTask(deviceId, objective)) return undefined;
  const device = resolveObjectiveDeviceInputs(deps.getDevices(), deps.getThermalDirection)
    .find((candidate) => candidate.id === deviceId);
  if (device === undefined) {
    return inactiveTaskEvaluation(deviceId, objective.deadlineAtMs, resolveObjectiveTargetValue(objective));
  }
  const progress = resolveObjectiveProgress(objective, device, deps.getDeliveredEnergyKWh);
  const evaluation = buildUnallocatedTaskEvaluation(deviceId, objective, progress);
  return {
    ...evaluation,
    completion: completionFromEvaluation(evaluation, deps.getStallClassification(deviceId), true),
  };
};
