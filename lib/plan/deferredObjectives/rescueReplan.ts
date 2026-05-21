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
  deadlineAtMs: number;
  steps: DeferredObjectiveStep[];
  commitment: ReturnType<typeof resolveCommittedHours>;
  policyHorizon: Extract<DeferredObjectivePolicyHorizonResult, { reasonCode: null }>;
  priceOptimizationEnabled: boolean;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
}): RescueHorizonResult => {
  const {
    nowMs,
    deviceId,
    objective,
    energyNeededKWh,
    deadlineAtMs,
    steps,
    commitment,
    policyHorizon,
    priceOptimizationEnabled,
    dailyBudgetSnapshot,
  } = params;
  const planForBuckets = (
    buckets: ResolvedHorizonBuckets,
  ): DeferredObjectiveHorizonPlan => planDeferredObjectiveHorizon({
    nowMs,
    objective: {
      id: `${deviceId}:${objective.kind}`,
      kind: objective.kind,
      enforcement: objective.enforcement,
      energyNeededKWh,
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
