import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { buildObjectiveSignature } from './activePlanSignature';
import type { DeferredObjectiveSettingsEntry } from './settings';

// Returns `undefined` when there is no active commitment for this objective
// (no persisted plan, plan still pending, signature mismatch, etc.) and the
// caller should let the horizon planner run the fresh optimizer. Returns
// `plan.commitment.hours` — which may be an empty array, e.g. when the first
// revision was a `cannot_meet` plan that allocated zero hours — when there is
// an active commitment. The caller distinguishes "no commitment" from
// "commitment with no hours" via the `undefined` vs `[]` boundary; downstream
// consumers must not collapse the two cases.
export const resolveCommittedHours = (params: {
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
}): DeferredObjectiveActivePlanHourV1[] | undefined => {
  const plan = params.activePlans?.plansByDeviceId[params.deviceId];
  if (!plan || plan.pending || !plan.commitment) return undefined;
  if (plan.deadlineAtMs !== params.objective.deadlineAtMs) return undefined;
  if (plan.objectiveKind !== params.objective.kind) return undefined;
  if (plan.objectiveSignature !== buildObjectiveSignature({
    objectiveKind: params.objective.kind,
    targetTemperatureC: params.objective.kind === 'temperature' ? params.objective.targetTemperatureC : null,
    targetPercent: params.objective.kind === 'ev_soc' ? params.objective.targetPercent : null,
    deadlineAtMs: params.objective.deadlineAtMs,
    enforcement: params.objective.enforcement,
  })) return undefined;
  return plan.commitment.hours;
};
