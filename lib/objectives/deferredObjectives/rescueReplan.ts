import { planDeferredObjectiveHorizon } from './horizonPlanner';
import {
  buildDeferredObjectivePolicyHorizon,
  type DeferredObjectivePolicyHorizonInputs,
  type DeferredObjectivePolicyHorizonResult,
} from './policyHorizon';
import type { CoordinatedDeferredObjective } from './priorityAllocation';
import type { DeferredObjectiveEnergyResolution } from './profileEnergyResolution';
import { resolveCommittedHours } from './resolveCommittedHours';
import type { DeferredObjectiveHorizonPlan, DeferredObjectiveStep } from './types';

// Reserve a flat 1-hour safety buffer before the deadline. The horizon planner
// allocates into the primary window (now → deadline − reserve) first and only dips
// into the reserve hour when every earlier hour is fully booked; crossing into the
// reserve flips the diagnostic to `at_risk` so users get actionable warning time.
const DEFAULT_DEADLINE_RESERVE_MS = 60 * 60 * 1000;

type ResolvedHorizonBuckets = Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>['buckets'];

// Resolve the horizon plan, applying the "exempt from budget" permission when it is set
// to 'always' (the only mode the action card sets in phase 1): the policy horizon is
// rebuilt with the per-bucket daily-budget cap lifted, so the device plans against the
// higher capacity from the start. This relaxes only the soft daily-budget throttle;
// physical capacity stays enforced downstream (admission / capacity guard). The 'at_risk'
// mode — re-solve only when the baseline would miss, with hysteresis so the rescue can't
// flap as it removes its own trigger — is phase 2.
//
// `profileEnergy` carries the buffered `energyNeededKWh` and its mean-based pair
// `energyExpectedKWh`; the planner uses the gap (`needed − expected = k·SE`) to
// soften a floor shortfall to `at_risk`/`estimate_uncertain` when only the
// variance buffer causes the gap. `null` for legacy/bootstrap profiles collapses
// the margin to zero. `aheadOfHourMilestone` is the producer-resolved trajectory
// gate for mid-execution price deferral: `true` when the measured value is
// already at/above the committed plan's end-of-this-hour milestone
// (`isAheadOfHourMilestone`). It is forwarded verbatim to the planner, which
// states it on `currentHourFacts` for `resolveCurrentHourClaim`. `horizonInputs`
// is what `policyHorizon` was built from; the exempt rebuild reuses it with the
// cap lifted, so its buckets source price and carry the same per-bucket
// `reservedHeadroomKw` forecast as the baseline, which a fully-reserved task on
// the exempt rebuild still needs for Slice 2's floor-step promotion.
export const resolveHorizonPlanWithRescue = (
  task: CoordinatedDeferredObjective,
  profileEnergy: Extract<DeferredObjectiveEnergyResolution, { reasonCode: null }>,
  steps: DeferredObjectiveStep[],
  commitment: ReturnType<typeof resolveCommittedHours>,
  aheadOfHourMilestone: boolean,
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>,
  horizonInputs: DeferredObjectivePolicyHorizonInputs,
): DeferredObjectiveHorizonPlan => {
  const { deviceId, objective } = task;
  // `fullyReserved` resolved here, at the rescue boundary that already owns
  // rescue-permission interpretation. Three conjuncts:
  //  1. exempt-from-budget `'always'` lifts the soft daily-budget cap.
  //  2. limit-lower-priority `'always'` lets the task displace lower-priority
  //     controlled devices when claiming physical headroom.
  //  3. every device ranked above this one is booked (resolved by the
  //     coordinator from the tasks it evaluated ahead of this one). The reserved-headroom forecast
  //     (`sustainableRate − gross background − higher-priority bookings`)
  //     leaves out controlled load, which holds only for load this task can
  //     displace or whose draw it already knows. Permission 2 covers
  //     lower ranks. A higher-ranked device can never be displaced, so its draw
  //     must be in the forecast: a smart-task device's bookings are, a plain
  //     device's draw is not. A task with no device above it is trivially booked.
  // Anything weaker stays at the min-step floor.
  const fullyReserved = task.higherRankedLoadBooked
    && objective.rescue?.exemptFromBudget === 'always'
    && objective.rescue?.limitLowerPriorityDevices === 'always';
  const planForBuckets = (
    buckets: ResolvedHorizonBuckets,
  ): DeferredObjectiveHorizonPlan => planDeferredObjectiveHorizon({
    nowMs: horizonInputs.nowMs,
    objective: {
      id: `${deviceId}:${objective.kind}`,
      kind: objective.kind,
      enforcement: objective.enforcement,
      energyNeededKWh: profileEnergy.energyNeededKWh,
      energyExpectedKWh: profileEnergy.energyExpectedKWh ?? undefined,
      fullyReserved,
      deadlineAtMs: objective.deadlineAtMs,
      deadlineMarginMs: DEFAULT_DEADLINE_RESERVE_MS,
    },
    steps,
    buckets,
    commitment: commitment === undefined
      ? { kind: 'uncommitted' }
      : { kind: 'committed', hours: commitment },
    aheadOfHourMilestone,
  });

  if (objective.rescue?.exemptFromBudget !== 'always') {
    return planForBuckets(policyHorizon.buckets);
  }
  const exemptHorizon = buildDeferredObjectivePolicyHorizon({ ...horizonInputs, exemptFromBudget: true });
  if (exemptHorizon.reasonCode) {
    // Exempt rebuild failed — fall back to the budget-capped baseline.
    return planForBuckets(policyHorizon.buckets);
  }
  return planForBuckets(exemptHorizon.buckets);
};
