import { describe, expect, it } from 'vitest';
import { buildExecutionPlan } from '../../lib/plan/planExecutionProjection';
import { hasPlannedStep } from '../../lib/planContract/executionPlan';
import { buildExecutableSteppedLoadDevice } from '../../lib/executor/executableSteppedLoadProjection';
import { buildPlanMeta, steppedPlanDevice } from '../utils/planTestUtils';

/** A decision remains frozen while its executor-owned command session changes. */
describe('planner execution boundary', () => {
  it('keeps retry and confirmation state in execution instead of the emitted decision', () => {
    const device = steppedPlanDevice({ selectedStepId: 'low', desiredStepId: 'max', plannedState: 'keep' });
    const plan = buildExecutionPlan({
      meta: buildPlanMeta(), devices: [device], chargingPhaseDecisions: [], inverterDecisions: [], storageReleases: [],
    });
    const decision = plan.devices[0]!;
    expect(hasPlannedStep(decision.commands)).toBe(true);
    if (!hasPlannedStep(decision.commands)) throw new Error('Expected a decided step');
    const requestedStepId = decision.commands.steppedLoad.desired.stepId;
    if (!requestedStepId) throw new Error('Expected a concrete requested step');
    expect(decision.commands.steppedLoad).not.toHaveProperty('matchingCommandAttempt');
    expect(decision.commands.steppedLoad).not.toHaveProperty('stepCommandRetryCount');
    expect(decision.commands).not.toHaveProperty('reason');
    expect(decision.commands).not.toHaveProperty('plannedState');
    const frozen = JSON.stringify(plan);
    const ordinarySession = {
      hasPriorStepCommand: false, stepCommandPending: false,
      unansweredStepCommands: { kind: 'none' as const },
    };
    const step = decision.commands.steppedLoad;
    const before = buildExecutableSteppedLoadDevice(step, undefined, decision.stepBaseline, ordinarySession);
    const during = buildExecutableSteppedLoadDevice(step, undefined, decision.stepBaseline, {
      ...ordinarySession,
      stepCommandPending: true,
      command: { stepId: requestedStepId, status: 'pending', retryCount: 1 },
    });
    expect(before?.matchingCommandAttempt).toBeNull();
    expect(during?.matchingCommandAttempt).toEqual({
      status: 'awaiting_confirmation', requestedStepId,
    });
    expect(JSON.stringify(plan)).toBe(frozen);
  });
});
