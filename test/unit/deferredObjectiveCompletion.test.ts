import { resolveLiveCompletion } from '../../lib/objectives/deferredObjectives/activePlanDiagnosticReason';
import { reportedPlanStatus } from '../../lib/objectives/deferredObjectives/activePlanRevisionBuild';
import { planDeferredObjectiveHorizon } from '../../lib/objectives/deferredObjectives/horizonPlanner';
import { buildAllocatedTaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluationProducer';
import { buildUnallocatedTaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluationProducer';
import { describe, expect, it } from 'vitest';
import { resolveTaskCompletion } from '../../lib/objectives/deferredObjectives/taskCompletion';
import { inactiveTaskEvaluation, type TaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluation';
import { resolveTaskCompletionDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { mergeRecord, startRecord } from '../../lib/objectives/deferredObjectives/planHistoryInProgressState';
import { partialDouble } from '../helpers/partialDouble';

const diagnostic = (overrides: Partial<DeferredObjectiveDiagnostic> = {}): DeferredObjectiveDiagnostic => {
  const resolved = partialDouble<DeferredObjectiveDiagnostic>({
    deviceId: 'heater', objectiveKind: 'temperature', deadlineAtMs: 3_600_000,
    targetValue: 65, reachableTargetValue: 65, currentValue: 61,
    progressDirection: 'increasing', reasonCode: 'planned_with_margin',
    trajectory: { kind: 'resolved', status: 'on_track' }, completion: { kind: 'unmet' },
    ...overrides,
  });
  const inactive = inactiveTaskEvaluation(resolved.deviceId, resolved.deadlineAtMs!, resolved.targetValue);
  const progress: TaskEvaluation['progress'] = resolved.currentValue !== null
    && resolved.progressDirection !== 'unknown' && resolved.completion.kind !== 'inactive'
    ? { kind: 'known', value: resolved.currentValue, direction: resolved.progressDirection }
    : { kind: 'unobserved' };
  const evaluation: TaskEvaluation = { ...inactive, progress, completion: resolved.completion,
    targetControl: resolved.objectiveKind === 'temperature'
      ? { kind: 'temperature', value: resolved.targetValue } : { kind: 'none' },
  };
  return { ...resolved, evaluation: overrides.evaluation ?? evaluation };
};
const nearTarget = { classification: 'near_target_idle' as const, classifiedAgainstTargetValue: 65, temperatureGapC: 4 };

describe('task completion evidence', () => {
  it('accepts the observer near-target band only for established temperature tasks', () => {
    expect(resolveTaskCompletionDiagnostic(diagnostic(), nearTarget, true).trajectory)
      .toEqual({ kind: 'resolved', status: 'satisfied' });
    expect(resolveTaskCompletionDiagnostic(diagnostic(), nearTarget, false).trajectory)
      .toEqual({ kind: 'resolved', status: 'on_track' });
    for (const objectiveKind of ['energy', 'ev_soc'] as const) {
      expect(resolveTaskCompletionDiagnostic(diagnostic({ objectiveKind }), nearTarget, true).trajectory)
        .toEqual({ kind: 'resolved', status: 'on_track' });
    }
  });

  it('keeps observer completion independent of reporting kind and columns when allocation is unavailable', () => {
    const evaluation = buildUnallocatedTaskEvaluation('heater', {
      enabled: true, kind: 'temperature', enforcement: 'soft',
      targetTemperatureC: 65, deadlineAtMs: 3_600_000,
    }, { reasonCode: null, remainingUnits: 4, currentValue: 61, progressDirection: 'increasing' });
    expect(evaluation.planning).toEqual({ kind: 'inactive' });
    expect(evaluation.targetControl).toEqual({ kind: 'temperature', value: 65 });
    for (const objectiveKind of ['temperature', 'ev_soc', 'energy'] as const) {
      const reported = diagnostic({
        evaluation, objectiveKind, currentValue: 80, targetValue: 80,
        reachableTargetValue: 70, reasonCode: 'objective_missing_price_horizon',
        trajectory: { kind: 'unavailable', reasonCode: 'objective_missing_price_horizon' },
      });
      expect(resolveTaskCompletionDiagnostic(reported, nearTarget, true).evaluation.completion)
        .toEqual({ kind: 'accepted_near_target' });
      expect(resolveTaskCompletionDiagnostic(reported, nearTarget, false).evaluation.completion)
        .toEqual({ kind: 'unmet' });
    }
  });

  it('does not treat a device internal cap as completion', () => {
    const capped = { ...nearTarget, classification: 'capped_idle' as const };
    expect(resolveTaskCompletionDiagnostic(diagnostic(), capped, true).trajectory)
      .toEqual({ kind: 'resolved', status: 'on_track' });
  });

  it('reopens accepted temperature completion on trusted observer exit', () => {
    const initial = startRecord(diagnostic(), 0, undefined)!;
    const accepted = mergeRecord(initial, resolveTaskCompletionDiagnostic(diagnostic(), nearTarget, true), 60_000, undefined);
    expect(accepted.satisfied).toBe(true);
    const reopened = mergeRecord(accepted, diagnostic({ currentValue: 55 }), 120_000, undefined);
    expect(reopened.satisfied).toBe(false);
    expect(reopened.metAtMs).toBeNull();
    expect(reopened.finalProgressValue).toBe(55);
  });

  it('preserves accepted completion while progress is unavailable', () => {
    const initial = startRecord(diagnostic(), 0, undefined)!;
    const accepted = mergeRecord(initial, resolveTaskCompletionDiagnostic(diagnostic(), nearTarget, true), 60_000, undefined);
    const unavailable = diagnostic({ completion: { kind: 'inactive' }, currentValue: null, reasonCode: 'objective_progress_stale', trajectory: { kind: 'unavailable', reasonCode: 'objective_progress_stale' } });
    expect(mergeRecord(accepted, unavailable, 120_000, undefined).satisfied).toBe(true);
  });

  it('never accepts a lower reachable EV limit as requested-target completion', () => {
    const limited = diagnostic({ objectiveKind: 'ev_soc', targetValue: 80, reachableTargetValue: 70, currentValue: 70, trajectory: { kind: 'resolved', status: 'satisfied' } });
    expect(startRecord(limited, 0, undefined)!.satisfied).toBe(false);
  });
});

describe('operational task completion', () => {
  it('uses only the requested target and known progress for reaching the obligation', () => {
    expect(resolveTaskCompletion({ currentValue: 70, requestedTarget: 80,
      direction: 'increasing', thermalEvidence: { kind: 'none' } })).toEqual({ kind: 'unmet' });
    expect(resolveTaskCompletion({ currentValue: 80, requestedTarget: 80,
      direction: 'increasing', thermalEvidence: { kind: 'none' } })).toEqual({ kind: 'target_reached' });
    expect(resolveTaskCompletion({ currentValue: 20, requestedTarget: 22,
      direction: 'decreasing', thermalEvidence: { kind: 'none' } })).toEqual({ kind: 'target_reached' });
  });

  it('accepts only eligible observer evidence covering the requested target', () => {
    expect(resolveTaskCompletion({ currentValue: 61, requestedTarget: 65,
      direction: 'increasing', thermalEvidence: { kind: 'accepted', evidence: nearTarget } }))
      .toEqual({ kind: 'accepted_near_target' });
    expect(resolveTaskCompletion({ currentValue: 55, requestedTarget: 65,
      direction: 'increasing', thermalEvidence: { kind: 'accepted',
        evidence: { ...nearTarget, classifiedAgainstTargetValue: 55 } } })).toEqual({ kind: 'unmet' });
  });

  it('keeps tiny positive energy obligations unmet despite a satisfied allocation forecast or report', () => {
    const objective = {
      enabled: true, kind: 'energy' as const, enforcement: 'soft' as const,
      targetEnergyKWh: 1, deadlineAtMs: 3_600_000,
    };
    const plan = planDeferredObjectiveHorizon({
      nowMs: 0, objective: {
        id: 'heater:energy', kind: 'energy', enforcement: 'soft', energyNeededKWh: 0.0005,
        deadlineAtMs: objective.deadlineAtMs, deadlineMarginMs: 0, fullyReserved: false,
      }, steps: [], buckets: [], commitment: { kind: 'uncommitted' }, aheadOfHourMilestone: false,
    });
    expect(plan.status).toBe('satisfied');
    const evaluation = buildAllocatedTaskEvaluation('heater', objective, {
      reasonCode: null, remainingUnits: 0.0005, currentValue: 0.9995, progressDirection: 'increasing',
    }, plan);
    expect(evaluation.completion).toEqual({ kind: 'unmet' });
    for (const status of ['satisfied', 'cannot_meet', 'on_track'] as const) {
      const report = diagnostic({ evaluation, trajectory: { kind: 'resolved', status } });
      expect(resolveLiveCompletion(report)).toEqual({ kind: 'unmet', status: 'on_track' });
      expect(reportedPlanStatus(report, plan)).toBe('on_track');
    }
    const reached = diagnostic({
      evaluation: { ...evaluation, completion: { kind: 'target_reached' } },
      trajectory: { kind: 'unavailable', reasonCode: 'objective_progress_stale' },
    });
    expect(resolveLiveCompletion(reached)).toEqual({ kind: 'satisfied' });
    expect(reportedPlanStatus(reached, plan)).toBe('satisfied');
    expect(resolveLiveCompletion(diagnostic({
      evaluation: { ...evaluation, planning: { kind: 'inactive' } },
    }))).toEqual({ kind: 'unavailable' });
  });

  it('records completion from the verdict independently of reporting reason codes', () => {
    const initial = startRecord(diagnostic(), 0, undefined)!;
    const misleadingReason = mergeRecord(initial,
      diagnostic({ reasonCode: 'objective_stalled_near_target' }), 60_000, undefined);
    expect(misleadingReason.satisfied).toBe(false);
    const accepted = mergeRecord(initial,
      diagnostic({ completion: { kind: 'accepted_near_target' } }), 60_000, undefined);
    expect(accepted.satisfied).toBe(true);
    expect(accepted.metReason).toBe('stalled');
    const reached = startRecord(diagnostic({ currentValue: 65,
      completion: { kind: 'target_reached' }, trajectory: { kind: 'unavailable', reasonCode: 'objective_missing_price_horizon' } }),
    60_000, undefined)!;
    expect(reached.satisfied).toBe(true);
  });
});
