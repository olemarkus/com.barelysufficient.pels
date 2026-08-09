import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import { planDeferredObjectiveHorizon } from './horizonPlanner';
import {
  buildDeferredObjectivePolicyHorizon,
  type DeferredObjectivePolicyHorizonResult,
  type DeferredObjectivePriorityReservation,
  type PriceHorizonEntry,
} from './policyHorizon';
import { resolveCommittedHours } from './resolveCommittedHours';
import type { DeferredObjectiveSettingsEntry } from './settings';
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
export const resolveHorizonPlanWithRescue = (params: {
  nowMs: number;
  deviceId: string;
  objective: DeferredObjectiveSettingsEntry;
  energyNeededKWh: number;
  // Mean-based pair to the buffered `energyNeededKWh`; the planner uses the
  // gap (`needed − expected = k·SE`) to soften a floor shortfall to
  // `at_risk`/`estimate_uncertain` when only the variance buffer causes the
  // gap. `null` for legacy/bootstrap profiles collapses the margin to zero.
  energyExpectedKWh: number | null;
  deadlineAtMs: number;
  steps: DeferredObjectiveStep[];
  commitment: ReturnType<typeof resolveCommittedHours>;
  // Producer-resolved trajectory gate for mid-execution price deferral: `true`
  // when the measured value is already at/above the committed plan's
  // end-of-this-hour milestone (`isAheadOfHourMilestone`). Forwarded verbatim to
  // the planner, which combines it with the relative-price test.
  aheadOfHourMilestone?: boolean;
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>;
  priceOptimizationEnabled: boolean;
  // Price-layer horizon (price + grid) forwarded to the exempt rebuild so it
  // sources price exactly like the baseline horizon did.
  priceHorizon: PriceHorizonEntry[];
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  // Threaded through to the exempt rebuild so its rebuilt buckets carry the
  // same per-bucket `reservedHeadroomKw` forecast as the baseline buckets —
  // a fully-reserved task running on the exempt rebuild still needs the
  // forecast for Slice 2's floor-step promotion.
  hardCapKw?: number | null;
  // Device priority on the same scale used by `planSort` (lower number = more
  // important; `1` is top). Slice-2 floor promotion only fires when the device
  // is strictly top-priority: the reserved-headroom forecast (`hardCap − gross
  // background`) implicitly assumes any controlled concurrent load can be
  // displaced, which is only true at priority 1. Non-top-priority tasks stay on
  // the min-step floor even with both rescue permissions set.
  devicePriority?: number;
  higherPriorityReservations?: readonly DeferredObjectivePriorityReservation[];
}): DeferredObjectiveHorizonPlan => {
  const {
    nowMs,
    deviceId,
    objective,
    energyNeededKWh,
    energyExpectedKWh,
    deadlineAtMs,
    steps,
    commitment,
    policyHorizon,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
  } = params;
  // `fullyReserved` resolved here, at the rescue boundary that already owns
  // rescue-permission interpretation. Three conjuncts:
  //  1. exempt-from-budget `'always'` lifts the soft daily-budget cap.
  //  2. limit-lower-priority `'always'` lets the task displace lower-priority
  //     controlled devices when claiming physical headroom.
  //  3. device is strictly top priority (`=== 1`). The reserved-headroom
  //     forecast (`hardCap − gross background`) implicitly assumes every
  //     controlled concurrent watt can be displaced, which only holds at the top. A
  //     non-top task with both permissions can still be denied by a *higher*-
  //     priority controlled device (which `limit-lower-priority` cannot shed),
  //     so the capacity guard would catch the wall but verdicts would
  //     oscillate. Active devices are projected to relative ranks before this
  //     clock runs, so `1` already means the highest-priority device present in
  //     this home. Promoting lower relative ranks needs the richer forecast
  //     tracked in TODO.
  // Anything weaker stays at the min-step floor.
  const fullyReserved = params.devicePriority === 1
    && objective.rescue?.exemptFromBudget === 'always'
    && objective.rescue?.limitLowerPriorityDevices === 'always';
  const planForBuckets = (
    buckets: ResolvedHorizonBuckets,
  ): DeferredObjectiveHorizonPlan => planDeferredObjectiveHorizon({
    nowMs,
    objective: {
      id: `${deviceId}:${objective.kind}`,
      kind: objective.kind,
      enforcement: objective.enforcement,
      energyNeededKWh,
      energyExpectedKWh: energyExpectedKWh ?? undefined,
      fullyReserved,
      deadlineAtMs,
      deadlineMarginMs: DEFAULT_DEADLINE_RESERVE_MS,
    },
    steps,
    buckets,
    committed: commitment !== undefined,
    committedHours: commitment,
    aheadOfHourMilestone: params.aheadOfHourMilestone,
  });

  if (objective.rescue?.exemptFromBudget !== 'always') {
    return planForBuckets(policyHorizon.buckets);
  }
  const exemptHorizon = buildDeferredObjectivePolicyHorizon({
    nowMs,
    deadlineAtMs,
    priceOptimizationEnabled,
    priceHorizon: params.priceHorizon,
    dailyBudgetSnapshot,
    exemptFromBudget: true,
    hardCapKw: params.hardCapKw,
    higherPriorityReservations: params.higherPriorityReservations,
  });
  if (exemptHorizon.reasonCode) {
    // Exempt rebuild failed — fall back to the budget-capped baseline.
    return planForBuckets(policyHorizon.buckets);
  }
  return planForBuckets(exemptHorizon.buckets);
};
