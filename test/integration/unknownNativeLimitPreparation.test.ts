import { describe, expect, it, vi } from 'vitest';
import { buildPlannedSteppedCommand } from '../../lib/plan/planSteppedCommand';
import { hasPlannedStep } from '../../lib/planContract/executionPlan';
import { hasStableDeviceActuation } from '../../lib/executor/planExecutorPredicates';
import { buildExecutableObservedDeviceState } from '../../lib/executor/executablePlanProjection';
import { buildExecutableSteppedLoadDevice } from '../../lib/executor/executableSteppedLoadProjection';
import { applySteppedLoadCommand } from '../../lib/executor/steppedLoadExecutor';
import type { ExecutorDeviceRead } from '../../lib/executor/executorDeviceRead';
import { createTestExecutorCommandContext, PRIOR_STEP_COMMAND_SESSION } from '../helpers/executorCommandContext';
import { executionDeviceForFixture } from '../utils/executionDecisionFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { steppedPlanDevice, steppedProfile } from '../utils/planTestUtils';

const unknownDevice = (plannedState: 'keep' | 'shed' = 'shed', currentDrawKw = 12.75) => steppedPlanDevice({
  id: 'charger', name: 'Charger', currentState: 'on', currentOn: true, binaryCapabilityId: 'evcharger_charging',
  plannedState, selectedStepId: 'low', desiredStepId: 'low', reportedStepId: undefined, currentDrawKw,
  plannedShedTargetKind: plannedState === 'shed' ? 'step' : undefined,
  shedAction: 'set_step', reason: { code: 'shortfall', shortfallKw: 9.7 },
  controlAdapter: { kind: 'capability_adapter', activationEnabled: true, activationRequired: false,
    activationOrder: 'current_before_start' },
});

const liveRead = (measuredPowerKw: number, on = true): ExecutorDeviceRead => ({
  id: 'charger', name: 'Charger', available: true, isEvCharger: true, targets: [],
  binaryControl: { on }, measuredPowerKw, steppedLoadProfile: steppedProfile,
});

describe('preparing an unknown native limit under capacity pressure', () => {
  it.each(['keep', 'shed'] as const)('keeps a measured downward preparation executable while %s', (state) => {
    const device = unknownDevice(state);
    const execution = executionDeviceForFixture(device);
    expect(hasPlannedStep(execution.commands)).toBe(true);
    if (!hasPlannedStep(execution.commands)) throw new Error('Expected native limit preparation');
    expect(execution.commands.steppedLoad).toMatchObject({
      desired: { stepId: 'low' }, stepDirection: 'down_only',
      transition: { effectiveTransition: 'step_down_while_on', transitionPhase: 'step_preparation' },
    });
    expect(execution.commands.steppedLoad).not.toHaveProperty('desiredOn');
    expect(execution.stableOperations).toContain('step_change');
    expect(hasStableDeviceActuation(execution, PRIOR_STEP_COMMAND_SESSION, false, false)).toBe(true);
    expect(device.reportedStepId).toBeUndefined();
  });

  it('leaves an unheld running keep at its planned step instead of preparing the lowest limit', () => {
    const device = steppedPlanDevice({ ...unknownDevice('keep'), desiredStepId: 'max', reason: { code: 'keep', detail: null } });
    const command = buildPlannedSteppedCommand(device);
    expect(command?.transition?.transitionPhase).not.toBe('step_preparation');
    expect(command?.desired.stepId).not.toBe('low');
  });

  // Owner ruling 2026-11-28: with no limit on, a meter outage leaves the charger
  // as it is, so the preparation that would lower it must not run.
  it('leaves a charger the silent-meter hold kept at its level, even with starts held', () => {
    const device = steppedPlanDevice({ ...unknownDevice('keep'), reason: { code: 'meter_silent_hold' } });
    const command = buildPlannedSteppedCommand(device, true);
    expect(command?.transition?.transitionPhase).not.toBe('step_preparation');
    expect(command?.desired.stepId ?? device.selectedStepId).toBe(device.selectedStepId);
  });

  it.each([0, 0.5, 1.25])('keeps the hold when measured draw is only %s kW', (watts) => {
    expect(buildPlannedSteppedCommand(unknownDevice('keep', watts))).toBeUndefined();
  });

  it.each([
    { drawKw: 12.75, on: true, requests: 1 },
    { drawKw: 0.5, on: true, requests: 0 },
    { drawKw: 1.25, on: true, requests: 0 },
    { drawKw: 12.75, on: false, requests: 0 },
  ])('rechecks live draw $drawKw kW and charging $on before dispatch', async ({ drawKw, on, requests }) => {
    const intent = buildPlannedSteppedCommand(unknownDevice());
    const initial = liveRead(12.75);
    const action = buildExecutableSteppedLoadDevice(intent,
      buildExecutableObservedDeviceState(initial, steppedProfile), undefined, PRIOR_STEP_COMMAND_SESSION);
    if (!action) throw new Error('Expected executable preparation');
    const apply = vi.fn().mockResolvedValue({ requested: false });
    const context = createTestExecutorCommandContext(createPlanEngineState(), {
      readDevice: () => liveRead(drawKw, on),
      actuator: { canTurnOnDevice: () => true, resolveTemperatureTarget: (_id, desired) => desired, apply },
    });
    await applySteppedLoadCommand(context, action, initial);
    expect(apply).toHaveBeenCalledTimes(requests);
    if (requests) expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'step', deviceId: 'charger', desiredStepId: 'low',
    }));
    expect(context.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
  });
});
