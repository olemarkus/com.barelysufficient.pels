import { resolveDeviceExecutionState } from '../../lib/executor/deviceExecutionState';
import { buildExecutableDeviceIntent, buildExecutableObservedDeviceStateFromSnapshot } from '../../lib/executor/executablePlanProjection';
import { buildDriftObservedSnapshot } from '../../lib/executor/driftObservedDevice';
import type { ObserverDeviceRead } from '../../lib/executor/driftObservedDevice';
import { steppedPlanDevice, buildPlanDevice } from '../utils/planTestUtils';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';

const noCommands = { binary: { kind: 'none' as const }, step: { kind: 'none' as const }, target: null };
const offPlan = steppedPlanDevice({
  id: 'connected-300', currentState: 'on', selectedStepId: 'low', reportedStepId: 'low',
  targetStepId: 'low', desiredStepId: 'low', plannedState: 'shed',
  plannedShedTargetKind: 'binary_off', shedAction: 'turn_off',
  reason: { code: 'deferred_objective_avoid' },
});
const profile = isSteppedLoadDevice(offPlan) ? offPlan.steppedLoadProfile : undefined;
const observe = (binaryOn: boolean, reportedStepId?: string) => buildExecutableObservedDeviceStateFromSnapshot(
  buildDriftObservedSnapshot({ id: offPlan.id, name: offPlan.name, available: true,
    targets: [], binaryControl: { on: binaryOn }, reportedStepId, steppedLoadProfile: profile,
  } as ObserverDeviceRead, profile),
);

describe('resolveDeviceExecutionState', () => {
  it('settles a binary-off decision despite a retained active step and target', () => {
    const state = resolveDeviceExecutionState(buildExecutableDeviceIntent(offPlan), observe(false, 'low'), noCommands, false);
    expect(state).toMatchObject({ physicalState: 'off', observedStepId: 'low', desiredBinary: 'off',
      desiredStepId: null, binaryProgress: 'settled', stepProgress: 'undriven', resumeExpected: false });
  });

  it('expects a step-only device to resume through its active step without a binary command', () => {
    const plan = steppedPlanDevice({ binaryCapabilityId: undefined, currentState: 'off',
      selectedStepId: 'off', reportedStepId: 'off', plannedState: 'keep',
      desiredStepId: 'low', targetStepId: 'low' });
    const observed = buildExecutableObservedDeviceStateFromSnapshot(buildDriftObservedSnapshot({
      id: plan.id, name: plan.name, available: true, targets: [], reportedStepId: 'off',
      steppedLoadProfile: plan.steppedLoadProfile,
    }, plan.steppedLoadProfile));
    const intent = buildExecutableDeviceIntent(plan);
    expect(resolveDeviceExecutionState(intent, observed, noCommands, false)).toMatchObject({
      physicalState: 'off', desiredBinary: null, desiredStepId: 'low', resumeExpected: true,
      stepProgress: 'unmet', steppedTransitionPending: false,
    });
    expect(resolveDeviceExecutionState(intent, observed, {
      ...noCommands, step: { kind: 'pending' },
    }, false)).toMatchObject({ stepProgress: 'pending', steppedTransitionPending: true });
  });

  it('reports a pending stepped transition while binary restoration waits at a matching active step', () => {
    const plan = steppedPlanDevice({ currentState: 'off', selectedStepId: 'low',
      reportedStepId: 'low', desiredStepId: 'low', targetStepId: 'low', plannedState: 'keep' });
    expect(resolveDeviceExecutionState(buildExecutableDeviceIntent(plan), observe(false, 'low'), {
      ...noCommands, binary: { kind: 'pending', desired: true },
    }, false)).toMatchObject({ physicalState: 'off', desiredBinary: 'on', resumeExpected: true,
      binaryProgress: 'pending', stepProgress: 'settled', steppedTransitionPending: true });
  });

  it('does not mistake a matching pending command for settled state', () => {
    const state = resolveDeviceExecutionState(buildExecutableDeviceIntent(offPlan), observe(true, 'low'), {
      ...noCommands, binary: { kind: 'pending', desired: false },
    }, false);
    expect(state).toMatchObject({ physicalState: 'on', binaryProgress: 'pending' });
    expect(resolveDeviceExecutionState(buildExecutableDeviceIntent(offPlan), observe(true, 'low'), noCommands, false)
      .binaryProgress).toBe('unmet');
  });

  it('leaves missing reported-step evidence unobserved instead of confirming a fallback', () => {
    const plan = steppedPlanDevice({ plannedState: 'shed', plannedShedTargetKind: 'step',
      plannedShedStepId: 'low', desiredStepId: 'low', selectedStepId: 'low', reportedStepId: undefined });
    const state = resolveDeviceExecutionState(buildExecutableDeviceIntent(plan), observe(true), noCommands, false);
    expect(state).toMatchObject({ physicalState: 'on', observedStepId: null, stepProgress: 'unobserved' });
  });

  it('retains independent raw binary and effective off-step truth', () => {
    const offStep = profile?.steps.find((step) => step.planningPowerW === 0);
    if (!offStep) throw new Error('fixture needs an off rung');
    const observed = observe(true, offStep.id);
    expect(observed.observedBinaryAxis).toBe('on');
    expect(resolveDeviceExecutionState(buildExecutableDeviceIntent(offPlan), observed, noCommands, false)
      .physicalState).toBe('off');
  });

  it('does not demand restoration while an external-off hold is active', () => {
    const keep = steppedPlanDevice({ plannedState: 'keep', desiredStepId: 'max' });
    expect(resolveDeviceExecutionState(buildExecutableDeviceIntent(keep), observe(false, 'low'), noCommands, true))
      .toMatchObject({ physicalState: 'off', desiredBinary: null, desiredStepId: null,
        binaryProgress: 'undriven', stepProgress: 'undriven', resumeExpected: false });
  });

  it('compares a binary lifecycle release against the raw handle even at an off rung', () => {
    const offStep = profile?.steps.find((step) => step.planningPowerW === 0);
    if (!offStep) throw new Error('fixture needs an off rung');
    const intent = buildExecutableDeviceIntent(steppedPlanDevice({
      id: offPlan.id, plannedState: 'keep', controllable: false, deferredReleaseIntent: 'binary_release',
    }));
    const state = resolveDeviceExecutionState(intent, observe(true, offStep.id), noCommands, false);
    expect(state).toMatchObject({ physicalState: 'off', desiredBinary: 'off', binaryProgress: 'unmet' });
  });

  it('compares a setpoint command against observed setpoint and pending command state', () => {
    const plan = buildPlanDevice({ deviceType: 'temperature', binaryCapabilityId: undefined,
      currentState: 'not_applicable', currentTarget: 18, plannedTarget: 21, currentTemperature: 19 });
    const observed = buildExecutableObservedDeviceStateFromSnapshot({ id: plan.id, name: plan.name,
      available: true, targets: [{ id: 'target_temperature', value: 18, unit: '°C' }] });
    const intent = buildExecutableDeviceIntent(plan);
    expect(resolveDeviceExecutionState(intent, observed, { ...noCommands, target: { desired: 21 } }, false))
      .toMatchObject({ targetProgress: 'pending', physicalState: 'not_applicable' });
    expect(resolveDeviceExecutionState(intent, observed, noCommands, false).targetProgress).toBe('unmet');
  });

  it('classifies absent observation as unavailable rather than inventing a device state', () => {
    expect(resolveDeviceExecutionState(buildExecutableDeviceIntent(offPlan), undefined, noCommands, false))
      .toMatchObject({ available: false, binaryProgress: 'unobserved' });
  });
});
