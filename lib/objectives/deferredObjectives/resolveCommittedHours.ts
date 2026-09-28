import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { buildObjectiveSignatureForEntry, compareObjectiveSignatures } from './activePlanSignature';
import type { DeferredObjectiveSettingsEntry } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { ObjectiveProgressDirectionRead } from '../../objectives/types';

export type ResolvedActiveCommittedPlan = {
  commitmentHours: DeferredObjectiveActivePlanHourV1[];
  latest: DeferredObjectiveActivePlanRevisionV1;
};

const objectiveSignatureFor = (
  objective: DeferredObjectiveSettingsEntry,
  progressDirection: ObjectiveProgressDirectionRead,
): string => buildObjectiveSignatureForEntry(objective, progressDirection);

// Returns the coherent active-plan view runtime consumers are allowed to use for
// committed smart-task control. Raw persisted plans are deliberately loose for
// legacy/pending compatibility; this accessor keeps that defensive handling in
// one place so callers never mix `commitment` and `latest` independently.
export const resolveActiveCommittedPlan = (params: {
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  progressDirection: ObjectiveProgressDirectionRead;
}): ResolvedActiveCommittedPlan | undefined => {
  const plan = params.activePlans?.plansByDeviceId[params.deviceId];
  if (!plan || plan.pending || !plan.commitment || plan.latest == null) return undefined;
  if (plan.deadlineAtMs !== params.objective.deadlineAtMs) return undefined;
  if (plan.objectiveKind !== params.objective.kind) return undefined;
  if (compareObjectiveSignatures(
    plan.objectiveSignature,
    objectiveSignatureFor(params.objective, params.progressDirection),
  ).changed) return undefined;
  return {
    commitmentHours: plan.commitment.hours,
    latest: plan.latest,
  };
};

// Returns `undefined` when there is no active commitment for this objective
// (no persisted plan, plan still pending, missing latest revision, signature
// mismatch, etc.) and the caller should let the horizon planner run the fresh
// optimizer. Returns `plan.commitment.hours` — which may be an empty array, e.g.
// when the first revision was a `cannot_meet` plan that allocated zero hours —
// when there is an active commitment. The caller distinguishes "no commitment"
// from "commitment with no hours" via the `undefined` vs `[]` boundary;
// downstream consumers must not collapse the two cases.
export const resolveCommittedHours = (params: {
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  progressDirection: ObjectiveProgressDirectionRead;
}): DeferredObjectiveActivePlanHourV1[] | undefined => (
  resolveActiveCommittedPlan(params)?.commitmentHours
);
