import type {
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  effectivePlanStatusOf, publishOverlayOnlyStatusChange,
} from '../../lib/objectives/deferredObjectives/effectivePlanStatusEvents';
import { resolvePublicRevisionWrittenEvent } from '../../lib/objectives/deferredObjectives/activePlanRevisionBuild';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { inactiveTaskEvaluation } from '../../lib/objectives/deferredObjectives/taskEvaluation';
import { partialDouble } from '../helpers/partialDouble';

const revision = partialDouble<DeferredObjectiveActivePlanRevisionV1>({
  planStatus: 'on_track', reason: 'schedule_revised', progressDirection: 'increasing', hours: [],
});
const plan = (waiting: boolean): DeferredObjectiveActivePlanV1 => partialDouble<DeferredObjectiveActivePlanV1>({
  deviceId: 'heater', deviceName: 'Heater', objectiveKind: 'temperature',
  latest: revision, liveCompletion: { kind: 'unavailable' }, targetValue: 55,
  ...(waiting ? { diagnosticReasonCode: 'objective_waiting_for_plan' as const } : {}),
});

describe('public status while an existing allocation waits for its planning turn', () => {
  it('announces waiting without replacing the retained revision', () => {
    const onRevisionWritten = vi.fn();
    const waiting = plan(true);
    expect(effectivePlanStatusOf(waiting)).toBeNull();
    publishOverlayOnlyStatusChange({ load: () => null, save: () => {}, onRevisionWritten }, waiting, 'on_track');
    expect(onRevisionWritten).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'pending_written', previousPlanStatus: 'on_track', previousWasPending: false,
      allocationChanged: false,
    }));
    expect(waiting.latest).toBe(revision);
  });

  it('does not announce the same waiting status on every cycle', () => {
    const onRevisionWritten = vi.fn();
    publishOverlayOnlyStatusChange({ load: () => null, save: () => {}, onRevisionWritten }, plan(true), null);
    expect(onRevisionWritten).not.toHaveBeenCalled();
  });

  it('announces recovery from waiting even when the schedule verdict stays on track', () => {
    const onRevisionWritten = vi.fn();
    publishOverlayOnlyStatusChange({ load: () => null, save: () => {}, onRevisionWritten }, plan(false), null);
    expect(onRevisionWritten).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'revision_written', previousPlanStatus: null, previousWasPending: true,
      effectivePlanStatus: 'on_track', allocationChanged: false, revision,
    }));
  });

  it('a new settled revision reports waiting as its preceding status', () => {
    const diagnostic = partialDouble<DeferredObjectiveDiagnostic>({
      deviceId: 'heater', deviceName: 'Heater', objectiveKind: 'temperature',
      progressDirection: 'increasing', evaluation: inactiveTaskEvaluation('heater', 10_000, 55),
    });
    expect(resolvePublicRevisionWrittenEvent(
      diagnostic, plan(true), revision, 'schedule_revised', false, null, 'on_track',
    )).toMatchObject({ previousPlanStatus: null, previousWasPending: true, effectivePlanStatus: 'on_track' });
  });
});
