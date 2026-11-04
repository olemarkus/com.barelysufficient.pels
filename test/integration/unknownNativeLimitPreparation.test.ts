import { describe, expect, it, vi } from 'vitest';
import { buildPlannedSteppedCommand } from '../../lib/plan/planSteppedCommand';
import { hasPlannedStep } from '../../lib/planContract/executionPlan';
import { hasStableDeviceActuation } from '../../lib/executor/planExecutorPredicates';
import { buildExecutableObservedDeviceState } from '../../lib/executor/executablePlanProjection';
import { buildExecutableSteppedLoadDevice } from '../../lib/executor/executableSteppedLoadProjection';
import { applySteppedLoadCommand } from '../../lib/executor/steppedLoadExecutor';
import type { ExecutorDeviceRead } from '../../lib/executor/executorDeviceRead';
import type { ActuatorOutcome, DeviceCommand } from '../../lib/actuator/deviceCommand';
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

  it('counts an issued native preparation as a write, without a binary stop or a step record', async () => {
    const initial = liveRead(12.75);
    const action = buildExecutableSteppedLoadDevice(buildPlannedSteppedCommand(unknownDevice()),
      buildExecutableObservedDeviceState(initial, steppedProfile), undefined, PRIOR_STEP_COMMAND_SESSION);
    if (!action) throw new Error('Expected executable preparation');
    const apply = vi.fn(async (_command: DeviceCommand): Promise<ActuatorOutcome> => ({
      requested: false, preparation: 'issued',
    }));
    const context = createTestExecutorCommandContext(createPlanEngineState(), {
      readDevice: () => initial, getObservedState: () => initial,
      actuator: { canTurnOnDevice: () => true, resolveTemperatureTarget: (_id, desired) => desired, apply },
    });
    expect(await applySteppedLoadCommand(context, action, initial)).toBe(true);
    expect(apply.mock.calls.map(([command]) => command.kind)).toEqual(['step']);
    expect(context.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'timed out', 'rejected'] as const)(
    'attributes its binary preparation before dispatch when the stop is %s', async (outcome) => {
      const initial = liveRead(12.75);
      const action = buildExecutableSteppedLoadDevice(buildPlannedSteppedCommand(unknownDevice()),
        buildExecutableObservedDeviceState(initial, steppedProfile), undefined, PRIOR_STEP_COMMAND_SESSION);
      if (!action) throw new Error('Expected executable preparation');
      const apply = vi.fn(async (command: DeviceCommand): Promise<ActuatorOutcome> => {
        if (command.kind === 'step') return { requested: false, preparation: 'binary_off' };
        if (command.kind !== 'binary') throw new Error('Unexpected command');
        // The ordinary binary owner records provenance BEFORE calling the SDK.
        expect(context.pendingBinaryCommandStore.peek('charger')).toMatchObject({
          desired: false, dispatchState: 'dispatching', logContext: 'capacity',
        });
        expect(context.pendingBinaryCommandStore.isBinaryChangeAttributableToPels('charger')).toBe(true);
        if (outcome === 'rejected') throw new Error('Stop rejected');
        return outcome === 'accepted'
          ? { requested: true, kind: 'binary', acknowledged: true }
          : { requested: true, kind: 'binary', acknowledged: false, err: new Error('No response') };
      });
      const context = createTestExecutorCommandContext(createPlanEngineState(), {
        readDevice: () => initial, getObservedState: () => initial,
        actuator: { canTurnOnDevice: () => true, resolveTemperatureTarget: (_id, desired) => desired, apply },
      });
      expect(await applySteppedLoadCommand(context, action, initial)).toBe(outcome !== 'rejected');
      expect(apply.mock.calls.map(([command]) => command.kind)).toEqual(['step', 'binary']);
      expect(apply).toHaveBeenCalledWith({ kind: 'binary', deviceId: 'charger', desired: false });
      expect(context.markSteppedLoadDesiredStepIssued).not.toHaveBeenCalled();
      if (outcome === 'rejected') expect(context.pendingBinaryCommandStore.peek('charger')).toBeUndefined();
      else expect(context.pendingBinaryCommandStore.peek('charger')).toMatchObject({
        desired: false, dispatchState: 'accepted',
      });
    },
  );
});
