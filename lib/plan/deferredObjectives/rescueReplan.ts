import type { DailyBudgetUiPayload } from '../../dailyBudget/dailyBudgetTypes';
import { planDeferredObjectiveHorizon } from './horizonPlanner';
import { buildDeferredObjectivePolicyHorizon, type DeferredObjectivePolicyHorizonResult } from './policyHorizon';
import { resolveCommittedHours } from './resolveCommittedHours';
import type { DeferredObjectiveSettingsEntry } from './settings';
import type { DeferredObjectiveHorizonPlan, DeferredObjectiveStep } from './types';

// Reserve a flat 1-hour safety buffer before the deadline. The horizon planner
// allocates into the primary window (now → deadline − reserve) first and only dips
// into the reserve hour when every earlier hour is fully booked; crossing into the
// reserve flips the diagnostic to `at_risk` so users get actionable warning time.
const DEFAULT_DEADLINE_RESERVE_MS = 60 * 60 * 1000;

type ResolvedHorizonBuckets = Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>['buckets'];

// The rescue resolver hands back the horizon plan plus the budget-exhaustion count of the
// horizon it actually used. The exempt rebuild lifts the per-bucket caps, so its count is 0
// — consumers must use this rather than the pre-rescue horizon's count.
type RescueHorizonResult = {
  plan: DeferredObjectiveHorizonPlan;
  dailyBudgetExhaustedBucketCount: number;
};

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
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>;
  priceOptimizationEnabled: boolean;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  // Threaded through to the exempt rebuild so its rebuilt buckets carry the
  // same per-bucket `reservedHeadroomKw` forecast as the baseline buckets —
  // a fully-reserved task running on the exempt rebuild still needs the
  // forecast for Slice 2's floor-step promotion.
  hardCapKw?: number | null;
  // Device priority on the same scale used by `planSort` (lower number = more
  // important; `1` is top). Slice-2 floor promotion only fires when the device
  // is strictly top-priority: the reserved-headroom forecast
  // (`hardCap − uncontrolled`) implicitly assumes any controlled concurrent
  // load can be displaced, which is only true at priority 1. Non-top-priority
  // tasks stay on the min-step floor even with both rescue permissions set.
  devicePriority?: number;
}): RescueHorizonResult => {
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
  //     forecast (`hardCap − uncontrolled`) implicitly assumes every controlled
  //     concurrent watt can be displaced, which only holds at the top. A
  //     non-top task with both permissions can still be denied by a *higher*-
  //     priority controlled device (which `limit-lower-priority` cannot shed),
  //     so the capacity guard would catch the wall but verdicts would
  //     oscillate. Strict `=== 1` is the safe v1 floor; broader semantics
  //     ("highest priority *present* on this Homey") tracked as TODO.
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
  });

  if (objective.rescue?.exemptFromBudget !== 'always') {
    return {
      plan: planForBuckets(policyHorizon.buckets),
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    };
  }
  const exemptHorizon = buildDeferredObjectivePolicyHorizon({
    nowMs,
    deadlineAtMs,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
    exemptFromBudget: true,
    hardCapKw: params.hardCapKw,
  });
  if (exemptHorizon.reasonCode) {
    // Exempt rebuild failed — fall back to the budget-capped baseline and its real count.
    return {
      plan: planForBuckets(policyHorizon.buckets),
      dailyBudgetExhaustedBucketCount: policyHorizon.dailyBudgetExhaustedBucketCount,
    };
  }
  // Exempt rebuild succeeded: the per-bucket caps are lifted for this device, so no bucket's
  // cap collapsed on its account. The exhaustion count otherwise reflects source-bucket budget
  // state regardless of the exemption, so report 0 here — a capacity/time-limited cannot_meet
  // must not be misattributed to the daily budget this task is exempt from.
  return {
    plan: planForBuckets(exemptHorizon.buckets),
    dailyBudgetExhaustedBucketCount: 0,
  };
};
