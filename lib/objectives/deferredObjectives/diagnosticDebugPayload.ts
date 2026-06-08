import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import { resolveFloorShortfallCause } from './floorShortfallCause';

// Flattens the optional horizon plan into log fields, defaulting each to null
// when no plan was produced. Extracted so the main payload builder stays under
// the cyclomatic-complexity cap once the new confidence/energy fields land.
const horizonPlanFields = (
  horizonPlan: DeferredObjectiveDiagnostic['horizonPlan'],
): Record<string, unknown> => ({
  plannedUsefulEnergyKWh: horizonPlan?.plannedUsefulEnergyKWh ?? null,
  unplannedUsefulEnergyKWh: horizonPlan?.unplannedUsefulEnergyKWh ?? null,
  usesDeadlineReserve: horizonPlan?.usesDeadlineReserve ?? null,
  priceDeferralEligible: horizonPlan?.priceDeferralEligible ?? null,
  plannedBuckets: horizonPlan?.plannedBuckets.map((bucket) => ({
    id: bucket.id, startMs: bucket.startMs, endMs: bucket.endMs,
    price: bucket.price, reserve: bucket.reserve, current: bucket.current,
    plannedUsefulEnergyKWh: bucket.plannedUsefulEnergyKWh,
  })) ?? null,
});

// Rescue-permission visibility. `*Mode` is what the user configured
// (`objective.rescue`), `*Applied` is whether the producer actually engaged it
// this cycle. Surfaced so a budget-capped `cannot_meet` can be told apart from
// one where exempt-from-budget was set but never reached/lifted the plan — the
// signal that was missing when the budget cap could not be distinguished from a
// physical limit. Producer resolves the flags; this helper only flattens them.
const rescueFields = (
  diagnostic: DeferredObjectiveDiagnostic,
): Record<string, unknown> => ({
  rescueExemptMode: diagnostic.rescue?.exemptFromBudget ?? 'off',
  rescueLimitMode: diagnostic.rescue?.limitLowerPriorityDevices ?? 'off',
  budgetExemptApplied: diagnostic.budgetExemptApplied ?? false,
  limitLowerPriorityApplied: diagnostic.limitLowerPriorityApplied ?? false,
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
  // Shared with the persisted active-plan revision so the structured log and
  // the UI hero copy resolver see the same producer-resolved verdict — see
  // `floorShortfallCause.ts` for the mapping table.
  floorShortfallCause: resolveFloorShortfallCause(diagnostic.reasonCode),
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
  // Re-derive the documented per-kind log fields from the now-unified in-memory
  // `kWhPerUnitBanded`, mirroring how the per-kind target/current fields above
  // are emitted, so existing structured-log analysis / dashboards (and the
  // `deferred-load-objectives` notes that list `kWhPerPercent`) keep working.
  kWhPerPercent: diagnostic.objectiveKind === 'ev_soc' ? diagnostic.kWhPerUnitBanded : null,
  kWhPerDegreeC: diagnostic.objectiveKind === 'temperature' ? diagnostic.kWhPerUnitBanded : null,
  kWhPerUnitBanded: diagnostic.kWhPerUnitBanded,
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
  expectedStepId: diagnostic.expectedStepId,
  ...rescueFields(diagnostic),
  ...horizonPlanFields(diagnostic.horizonPlan),
});
