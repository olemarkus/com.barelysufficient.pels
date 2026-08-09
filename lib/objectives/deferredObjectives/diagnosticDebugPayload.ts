import { resolvedTrajectoryStatus } from './diagnosticTypes';
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
  coldStartReleaseEligible: horizonPlan?.coldStartReleaseEligible ?? null,
  // The producer's claim on the current hour, and therefore the admission decision:
  // `claimed` runs the device, `released` stands it down, `unclaimed` leaves it to
  // the planner's own priority call. Without it a log reader cannot tell "on because
  // its task claimed the hour" from "on because its task could not claim the hour
  // but still needs it" — the exact discrimination the investigation that produced
  // this state needed and could not make.
  currentHourClaim: horizonPlan?.currentHourClaim ?? null,
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
  rescuePauseMode: diagnostic.rescue?.pauseLowerPriorityDevices ?? 'off',
  budgetExemptApplied: diagnostic.budgetExemptApplied ?? false,
  limitLowerPriorityApplied: diagnostic.limitLowerPriorityApplied ?? false,
  pauseLowerPriorityApplied: diagnostic.pauseLowerPriorityApplied ?? false,
});

export const buildDeferredObjectiveDebugPayload = (
  diagnostic: DeferredObjectiveDiagnostic,
): Record<string, unknown> => ({
  event: diagnostic.trajectory.kind === 'unavailable'
    ? 'deferred_objective_unknown'
    : 'deferred_objective_horizon_planned',
  deviceId: diagnostic.deviceId,
  ...(diagnostic.deviceName ? { deviceName: diagnostic.deviceName } : {}),
  objectiveId: diagnostic.objectiveId,
  objectiveKind: diagnostic.objectiveKind,
  enforcement: diagnostic.enforcement,
  status: resolvedTrajectoryStatus(diagnostic) ?? 'unknown',
  reasonCode: diagnostic.reasonCode,
  // Logged separately from `reasonCode` because it no longer replaces it — the
  // planner's verdict and the live hold are independent facts about the cycle.
  ...(diagnostic.externalOffHoldActive === true ? { externalOffHoldActive: true } : {}),
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
  expectedStepId: diagnostic.expectedStepId,
  // Degradation marker: this cycle was served from the frozen committed plan
  // because the live step ladder was unavailable. Without it, a horizon_planned
  // event during a step gap is indistinguishable from a healthy one — the
  // 2026-08-01 pace collapse was undiagnosable from the logs for exactly this
  // class of reason (the config flag looked fine while the applied state differed).
  ...(diagnostic.liveStepsUnavailable === true ? { liveStepsUnavailable: true } : {}),
  ...rescueFields(diagnostic),
  ...horizonPlanFields(diagnostic.horizonPlan),
});
