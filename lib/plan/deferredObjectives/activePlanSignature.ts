import type { DeferredObjectiveRescuePermissions } from './settings';

type ObjectiveSignatureParams = {
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  enforcement: 'soft' | 'hard';
  rescue?: DeferredObjectiveRescuePermissions;
};

const buildRescueSignatureSegment = (
  rescue: DeferredObjectiveRescuePermissions | undefined,
): ['rescue', string | null, string | null] | null => {
  const exemptFromBudget = rescue?.exemptFromBudget ?? null;
  const limitLowerPriorityDevices = rescue?.limitLowerPriorityDevices ?? null;
  if (!exemptFromBudget && !limitLowerPriorityDevices) return null;
  return ['rescue', exemptFromBudget, limitLowerPriorityDevices];
};

export const buildObjectiveSignature = (params: ObjectiveSignatureParams): string => {
  const base = [
    params.objectiveKind,
    params.targetTemperatureC,
    params.targetPercent,
    params.deadlineAtMs,
    params.enforcement,
  ];
  const rescue = buildRescueSignatureSegment(params.rescue);
  return JSON.stringify(rescue ? [...base, rescue] : base);
};
