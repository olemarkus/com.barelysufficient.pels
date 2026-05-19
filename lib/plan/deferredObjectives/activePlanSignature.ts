export const buildObjectiveSignature = (params: {
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  enforcement: 'soft' | 'hard';
}): string => JSON.stringify([
  params.objectiveKind,
  params.targetTemperatureC,
  params.targetPercent,
  params.deadlineAtMs,
  params.enforcement,
]);
