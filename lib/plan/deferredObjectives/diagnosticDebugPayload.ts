import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';

// Flattens the optional horizon plan into log fields, defaulting each to null
// when no plan was produced. Extracted so the main payload builder stays under
// the cyclomatic-complexity cap once the new confidence/energy fields land.
const horizonPlanFields = (
  horizonPlan: DeferredObjectiveDiagnostic['horizonPlan'],
): Record<string, unknown> => ({
  plannedUsefulEnergyKWh: horizonPlan?.plannedUsefulEnergyKWh ?? null,
  unplannedUsefulEnergyKWh: horizonPlan?.unplannedUsefulEnergyKWh ?? null,
  usesDeadlineReserve: horizonPlan?.usesDeadlineReserve ?? null,
  usesPolicyAvoid: horizonPlan?.usesPolicyAvoid ?? null,
  plannedBuckets: horizonPlan?.plannedBuckets.map((bucket) => ({
    id: bucket.id, startMs: bucket.startMs, endMs: bucket.endMs,
    preference: bucket.preference, reserve: bucket.reserve, current: bucket.current,
    plannedUsefulEnergyKWh: bucket.plannedUsefulEnergyKWh,
  })) ?? null,
});

export const buildDeferredObjectiveDebugPayload = (
  diagnostic: DeferredObjectiveDiagnostic,
): Record<string, unknown> => ({
  event: diagnostic.status === 'unknown' ? 'deferred_objective_unknown' : 'deferred_objective_horizon_planned',
  deviceId: diagnostic.deviceId,
  ...(diagnostic.deviceName ? { deviceName: diagnostic.deviceName } : {}),
  objectiveId: diagnostic.objectiveId,
  objectiveKind: diagnostic.objectiveKind,
  enforcement: diagnostic.enforcement,
  status: diagnostic.status,
  reasonCode: diagnostic.reasonCode,
  targetPercent: diagnostic.targetPercent,
  currentPercent: diagnostic.currentPercent,
  targetTemperatureC: diagnostic.objectiveKind === 'temperature' ? diagnostic.targetTemperatureC : null,
  currentTemperatureC: diagnostic.objectiveKind === 'temperature' ? diagnostic.currentTemperatureC : null,
  energyNeededKWh: diagnostic.energyNeededKWh,
  // Mean-based estimate (no buffer). Logged alongside the buffered
  // `energyNeededKWh` so analysis can derive the plan-time variance margin
  // (`energyNeededKWh − energyExpectedKWh`, the integrated `k·SE`) — the
  // band-residual signal the Cause #1 Step 2/3 validation gate needs to confirm
  // mature devices stop planning off a permanently-wide buffer.
  energyExpectedKWh: diagnostic.energyExpectedKWh ?? null,
  kWhPerPercent: diagnostic.kWhPerPercent,
  kWhPerDegreeC: diagnostic.kWhPerDegreeC,
  rateConfidence: diagnostic.rateConfidence,
  // Band-aware confidence the smart-task chip reads. Distinct from
  // `rateConfidence` (the global per-sample CV stat, pinned `low` on thermal
  // devices). This is the value the confidence-aware verdict (Step 3) would
  // gate on, so capturing it at plan time is the prerequisite for judging
  // whether Steps 1–2 actually let it reach medium/high.
  displayConfidence: diagnostic.displayConfidence,
  kwhPerUnitSource: diagnostic.kwhPerUnitSource,
  deadlineAtMs: diagnostic.deadlineAtMs,
  deadlineLocalTime: diagnostic.deadlineLocalTime,
  horizonBucketCount: diagnostic.horizonBucketCount,
  dailyBudgetExhaustedBucketCount: diagnostic.dailyBudgetExhaustedBucketCount,
  requestedMinimumStepId: diagnostic.requestedMinimumStepId,
  ...horizonPlanFields(diagnostic.horizonPlan),
});
