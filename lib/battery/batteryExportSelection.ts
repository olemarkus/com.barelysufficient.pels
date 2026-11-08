import type { BatteryEnergyPlan, BatteryPriceExportPolicy } from '../../packages/contracts/src/batteryPlan';
import type { ContinuousBatteryExportDecision } from '../../packages/contracts/src/continuousBatteryPlan';
import type { ContinuousBatteryHorizonRead } from '../ports/continuousBatteryPlan';
import { compareBatteryExportEconomics, estimateBatteryEnergyTransitions } from './planning/planBatteryEnergy';

type ReadyHorizon = Extract<ContinuousBatteryHorizonRead, { kind: 'ready' }>;
type PlannedBatteryEnergy = Extract<BatteryEnergyPlan, { status: 'planned' }>;

/**
 * The conservative search-work bound for one export comparison, in attempted
 * energy transitions (`estimateBatteryEnergyTransitions`). It limits work, not
 * wall-clock time; a larger horizon keeps the household plan.
 */
export const MAX_EXPORT_COMPARISON_TRANSITIONS = 2_000_000;

export type BatteryExportSelection = { plan: PlannedBatteryEnergy; decision: ContinuousBatteryExportDecision };

/**
 * What every battery that sells in one plan shares: the Main-meter export
 * ceiling, the lowest any selling battery's owner set, and the comparison work
 * they may spend together, one battery's bound, so several selling batteries
 * cost no more than one did. A battery past the work bound keeps its household
 * plan and says selling waits.
 */
export class FleetExportTerms {
  readonly policy: BatteryPriceExportPolicy;
  private remaining = MAX_EXPORT_COMPARISON_TRANSITIONS;

  constructor(netExportCeilingKW: number) {
    this.policy = { kind: 'price_export', netExportCeilingKW };
  }

  take(transitions: number): boolean {
    if (transitions > this.remaining) return false;
    this.remaining -= transitions;
    return true;
  }
}

/**
 * The plan to execute under the owner's price-export policy. Selling needs a
 * real export quote for every period: an absent quote is never a zero price, so
 * incomplete quotes keep the household plan and say selling is waiting. The
 * export-capable candidate replaces the household plan only when it is strictly
 * cheaper at the same final stored energy (`compareBatteryExportEconomics`).
 */
export function selectBatteryExportPlan(
  input: ReadyHorizon,
  household: PlannedBatteryEnergy,
  terms: FleetExportTerms,
): BatteryExportSelection {
  const { policy } = terms;
  if (input.exportPricing !== 'complete') {
    return { plan: household, decision: { kind: 'waiting', reason: 'export_prices_incomplete' } };
  }
  if (!terms.take(estimateBatteryEnergyTransitions(input.horizon))) {
    return { plan: household, decision: { kind: 'waiting', reason: 'evaluation_budget_exceeded' } };
  }
  const comparison = compareBatteryExportEconomics(input.horizon, policy, household);
  if (comparison.kind !== 'compared' || comparison.selection !== 'export_candidate') {
    return { plan: household, decision: { kind: 'kept_household' } };
  }
  return {
    plan: comparison.candidate,
    decision: {
      kind: 'selling', estimatedSavings: comparison.estimatedSavings, netExportCeilingKW: policy.netExportCeilingKW,
    },
  };
}
