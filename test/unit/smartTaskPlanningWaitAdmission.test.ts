import type { PlanInputDevice } from '../../packages/planner-types/src/planInputDevice';
import {
  applyDeferredAdmissionToInput, applyDeferredObjectiveAdmission, buildDeferredReleaseIntents,
} from '../../lib/objectives/deferredObjectives/admission';
import {
  inactiveTaskEvaluation, type TaskEvaluation,
} from '../../lib/objectives/deferredObjectives/taskEvaluation';
import { partialDouble } from '../helpers/partialDouble';

const device = partialDouble<PlanInputDevice>({
  id: 'heater', controlModel: 'binary_power',
  control: partialDouble<PlanInputDevice['control']>({ commandAuthority: true }),
});

const waiting = (posture: 'replanning' | 'unchanged'): TaskEvaluation => ({
  ...inactiveTaskEvaluation('heater', 60_000, 55),
  planning: { kind: 'awaiting_plan', device: posture },
  targetControl: { kind: 'temperature', value: 55 },
  permissions: { budgetExempt: true, limitLowerPriority: true, pauseLowerPriority: true },
});

describe('admission while a smart task waits for its planning turn', () => {
  it('leaves ordinary device control intact until the first plan exists', () => {
    const decisions = applyDeferredObjectiveAdmission([waiting('unchanged')], [device]);
    expect(decisions.get(device.id)).toEqual({ kind: 'inactive', budgetExempt: false });
    expect(buildDeferredReleaseIntents(decisions)).toEqual({});
    const admitted = applyDeferredAdmissionToInput([device], decisions);
    expect(admitted.devices[0]).toBe(device);
    expect(admitted.forceShedSet.size).toBe(0);
    expect(admitted.lentAuthorityDeviceIds.size).toBe(0);
  });

  it('leaves an incompatible plan waiting without a release, floor, or rescue permissions', () => {
    const decisions = applyDeferredObjectiveAdmission([waiting('replanning')], [device]);
    expect(decisions.get(device.id)).toEqual({ kind: 'waiting', budgetExempt: false });
    expect(buildDeferredReleaseIntents(decisions)).toEqual({});
    const admitted = applyDeferredAdmissionToInput([device], decisions);
    expect(admitted.forceShedSet.size).toBe(0);
    expect(admitted.devices[0]).toEqual({ ...device, waitingForTaskPlan: true });
  });

  it('retains the price-wait hold when prices have not reached the deadline', () => {
    const evaluation: TaskEvaluation = {
      ...waiting('unchanged'), planning: { kind: 'awaiting_prices', device: 'held' },
    };
    expect(applyDeferredObjectiveAdmission([evaluation], [device]).get(device.id)).toMatchObject({
      kind: 'idle', holdCause: 'cheaper_hours', releaseIntent: 'binary_release', budgetExempt: false,
    });
  });
});
