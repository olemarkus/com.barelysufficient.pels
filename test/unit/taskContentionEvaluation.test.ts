import { describe, expect, it, vi } from 'vitest';
import { resolveHigherPriorityContentionEvaluation } from '../../lib/objectives/deferredObjectives/contentionOverlay';
import { reportHigherPriorityContention } from '../../lib/objectives/deferredObjectives/contentionReporting';
import { inactiveTaskEvaluation, type TaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluation';
import type { DeferredObjectiveHorizonPlan } from '../../lib/objectives/deferredObjectives/types';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import type { DeferredObjectivePriorityReservation } from '../../lib/objectives/deferredObjectives/policyHorizon';
import { partialDouble } from '../helpers/partialDouble';

const evaluation = (unplannedUsefulEnergyKWh: number, frozenRead = false): TaskEvaluation => ({
  ...inactiveTaskEvaluation('lower-task', 3_600_000, 65),
  progress: { kind: 'known', value: 50, direction: 'increasing' },
  completion: { kind: 'unmet' },
  planning: { kind: 'allocated', plan: partialDouble<DeferredObjectiveHorizonPlan>({
    unplannedUsefulEnergyKWh,
    ...(frozenRead ? { frozenRead: true as const } : {}),
    status: 'at_risk', statusDetail: 'feasible_above_floor',
    currentBucket: null, currentHourClaim: 'released', priceDeferralEligible: false,
  }) },
});
const reservations = [partialDouble<DeferredObjectivePriorityReservation>({})];

describe('operational task contention', () => {
  it('attributes competing claims only after the unconstrained control allocation fits', () => {
    const constrained = evaluation(1);
    const result = resolveHigherPriorityContentionEvaluation({
      evaluation: constrained, higherPriorityReservations: reservations,
      buildWithoutReservations: () => evaluation(0),
    });
    expect(result.planning).toMatchObject({ kind: 'allocated', plan: {
      status: 'at_risk', statusDetail: 'limited_by_higher_priority_task', currentHourClaim: 'unclaimed',
    } });
    expect(result.completion).toEqual({ kind: 'unmet' });
    const misleadingReport = partialDouble<DeferredObjectiveDiagnostic>({
      evaluation: constrained, trajectory: { kind: 'resolved', status: 'satisfied' },
      reasonCode: 'objective_stalled_near_target',
    });
    expect(reportHigherPriorityContention(misleadingReport, result)).toMatchObject({
      evaluation: result, trajectory: { kind: 'resolved', status: 'at_risk' },
      reasonCode: 'limited_by_higher_priority_task',
    });
  });

  it('keeps the original allocation when the control still falls short or is inactive', () => {
    const constrained = evaluation(1);
    for (const control of [evaluation(0.5), inactiveTaskEvaluation('lower-task', 3_600_000, 65)]) {
      expect(resolveHigherPriorityContentionEvaluation({
        evaluation: constrained, higherPriorityReservations: reservations,
        buildWithoutReservations: () => control,
      })).toBe(constrained);
    }
  });

  it('keeps frozen commitment truth without running a fresh attribution probe', () => {
    const frozen = evaluation(1, true);
    const buildWithoutReservations = vi.fn(() => evaluation(0));
    expect(resolveHigherPriorityContentionEvaluation({
      evaluation: frozen, higherPriorityReservations: reservations, buildWithoutReservations,
    })).toBe(frozen);
    expect(buildWithoutReservations).not.toHaveBeenCalled();
  });
});
