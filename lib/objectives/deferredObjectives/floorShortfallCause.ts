import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';

// Producer-side mapping from the planner's `statusDetail` (carried on the
// diagnostic as `reasonCode`) to the consumer-facing flat-resolved
// `floorShortfallCause`:
//   `budget`        = soft daily budget net of forecast background bound the
//                     floor — includes both the cumulative-exhaustion case
//                     (`dailyBudgetExhaustedBucketCount > 0`) AND the
//                     per-bucket background-squeeze case (count = 0 but the
//                     floor still fits only because the per-bucket cap is
//                     binding). Squeeze case was the original motivation for
//                     persisting this signal — `bucketCount` alone misses it.
//   `step_power`    = floor-step undercount (climbing within budget fits).
//   `estimate`      = within the producer's variance buffer; the mean rate
//                     would fit and only the `k·SE` padding causes the gap.
//   `time_capacity` = physical/time even uncapped.
//   `none`          = no shortfall (target met or `unplannedUsefulEnergyKWh
//                     <= epsilonKWh`), or the reasonCode is one of the
//                     non-shortfall variants (`planned_with_margin`,
//                     `planned_using_deadline_reserve`, etc.). Persisting `none`
//                     is the byte-stable "no budget-bound recourse" shape;
//                     the recorder only writes the field on the cases where
//                     it's meaningful.
//
// Both the structured debug payload (`diagnosticDebugPayload.ts`) and the
// active-plan recorder (`activePlanRecorder.ts`) share this table so the log
// signal and the persisted UI signal can never drift.
const FLOOR_SHORTFALL_CAUSE_BY_REASON: Record<string, DeferredObjectiveActivePlanFloorShortfallCause> = {
  limited_by_daily_budget: 'budget',
  feasible_above_floor: 'step_power',
  estimate_uncertain: 'estimate',
  target_cannot_be_met: 'time_capacity',
};

export const resolveFloorShortfallCause = (
  reasonCode: string | null | undefined,
): DeferredObjectiveActivePlanFloorShortfallCause => (
  FLOOR_SHORTFALL_CAUSE_BY_REASON[reasonCode ?? ''] ?? 'none'
);
