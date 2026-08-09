import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';

// Producer-side mapping from the planner's `statusDetail` (carried on the
// diagnostic as `reasonCode`) to the consumer-facing flat-resolved
// `floorShortfallCause`:
//   `budget`        = the hour's own share of the soft daily budget bound the
//                     floor. This is the ONLY budget signal a consumer gets.
//                     There is deliberately no companion "the day total was
//                     reached" count: the day total is not a per-hour fact, and
//                     reading it as one is what used to unbook the tail hours of
//                     any day whose plan sums past its budget.
//   `step_power`    = floor-step undercount (climbing within budget fits).
//   `estimate`      = within the producer's variance buffer; the mean rate
//                     would fit and only the `k·SE` padding causes the gap.
//   `time_capacity` = physical/time even uncapped.
//
// "Leave off until turned on again" deliberately has NO entry here. This value is
// frozen into a committed revision at the settle, and the hold is transient: the
// user can turn the device back on at any moment, and a frozen `device_left_off`
// would keep explaining the risk with a device that is now running. It travels as
// a live `diagnosticReasonCode` overlay instead — see `resolveExternalOffReportedStatus`.
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
  limited_by_higher_priority_task: 'time_capacity',
  target_cannot_be_met: 'time_capacity',
};

export const resolveFloorShortfallCause = (
  reasonCode: string | null | undefined,
): DeferredObjectiveActivePlanFloorShortfallCause => (
  FLOOR_SHORTFALL_CAUSE_BY_REASON[reasonCode ?? ''] ?? 'none'
);
