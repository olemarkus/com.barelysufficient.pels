import type { DeferredHoldCause } from '../../../packages/planner-types/src/deferredDecoration';
import type { DeferredAdmissionDecision } from './admission';
import type { DeferredObjectiveDiagnostic } from './diagnosticTypes';

/**
 * What the smart-task controller decided for one task in its latest cycle, kept
 * for diagnostics reports. The decision explains a device the plan alone cannot:
 * `planned` lets the task start it, `idle` holds it (with why), `inactive` means
 * the task could not plan, with `reasonCode` naming the missing precondition.
 *
 * A flat copy of the few fields a report states, never the diagnostic itself:
 * the controller keeps one per live task, replaced every cycle.
 */
export type SmartTaskCycleRecord = {
  atMs: number;
  decision: DeferredAdmissionDecision['kind'];
  holdCause?: DeferredHoldCause;
  budgetExempt: boolean;
  engageBoost?: boolean;
  reservesStartupPower?: boolean;
  reasonCode: DeferredObjectiveDiagnostic['reasonCode'];
  /** The trajectory verdict, or `unavailable` when this cycle could not compute one. */
  trajectory: string;
  currentValue: number | null;
  energyNeededKWh: number | null;
  planningSpeedKw: number | null;
  kwhPerUnitSource: DeferredObjectiveDiagnostic['kwhPerUnitSource'];
  kwhPerUnitAcceptedSamples: number;
  liveStepsUnavailable?: true;
};

const decisionFields = (decision: DeferredAdmissionDecision): Pick<SmartTaskCycleRecord,
  'decision' | 'holdCause' | 'budgetExempt' | 'engageBoost' | 'reservesStartupPower'> => {
  if (decision.kind === 'planned') {
    return {
      decision: 'planned', budgetExempt: decision.budgetExempt,
      engageBoost: decision.engageBoost, reservesStartupPower: decision.reservesStartupPower,
    };
  }
  if (decision.kind === 'idle') {
    return { decision: 'idle', budgetExempt: decision.budgetExempt, holdCause: decision.holdCause };
  }
  return { decision: 'inactive', budgetExempt: decision.budgetExempt };
};

export const buildSmartTaskCycleRecord = (
  diagnostic: DeferredObjectiveDiagnostic,
  decision: DeferredAdmissionDecision,
  atMs: number,
): SmartTaskCycleRecord => ({
  atMs,
  ...decisionFields(decision),
  reasonCode: diagnostic.reasonCode,
  trajectory: diagnostic.trajectory.kind === 'resolved' ? diagnostic.trajectory.status : 'unavailable',
  currentValue: diagnostic.currentValue,
  energyNeededKWh: diagnostic.energyNeededKWh,
  planningSpeedKw: diagnostic.planningSpeedKw,
  kwhPerUnitSource: diagnostic.kwhPerUnitSource,
  kwhPerUnitAcceptedSamples: diagnostic.kwhPerUnitAcceptedSamples,
  ...(diagnostic.liveStepsUnavailable ? { liveStepsUnavailable: true as const } : {}),
});
