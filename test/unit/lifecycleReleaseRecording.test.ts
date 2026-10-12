import {
  selectShedActuationRecorder,
  shedActuationStampsCapacityMarkers,
} from '../../lib/executor/lifecycleReleaseRecording';
import { resolveConfirmedBinaryCommandReasonCode } from '../../lib/executor/planExecutorPredicates';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { ActuationRecorder } from '../../lib/executor/executorCommandContext';

type PendingBinaryCommand = PlanEngineState['pendingBinaryCommands'][string];

const offPending = (over: Partial<PendingBinaryCommand>): PendingBinaryCommand => ({
  dispatchState: 'accepted',
  desired: false,
  startedMs: 0,
  ...over,
});

describe('lifecycleReleaseRecording shared rule', () => {
  describe('selectShedActuationRecorder', () => {
    const recorders = {
      recordShedActuation: vi.fn<ActuationRecorder>(),
      recordReleaseShedActuation: vi.fn<ActuationRecorder>(),
    };
    it('routes lifecycle release to the diagnostic-only recorder', () => {
      expect(selectShedActuationRecorder(true, recorders)).toBe(recorders.recordReleaseShedActuation);
    });
    it('routes a capacity shed to the shed recorder', () => {
      for (const lifecycleRelease of [false, undefined]) {
        expect(selectShedActuationRecorder(lifecycleRelease, recorders)).toBe(recorders.recordShedActuation);
      }
    });
  });

  describe('shedActuationStampsCapacityMarkers', () => {
    it('only a capacity shed stamps the markers', () => {
      expect(shedActuationStampsCapacityMarkers(true)).toBe(false);
      expect(shedActuationStampsCapacityMarkers(false)).toBe(true);
      expect(shedActuationStampsCapacityMarkers(undefined)).toBe(true);
    });
  });

  describe('resolveConfirmedBinaryCommandReasonCode', () => {
    it('labels a confirmed OFF lifecycle_release for a lifecycle release, else shedding', () => {
      expect(resolveConfirmedBinaryCommandReasonCode(offPending({ lifecycleRelease: true }))).toBe('lifecycle_release');
      expect(resolveConfirmedBinaryCommandReasonCode(offPending({ lifecycleRelease: false }))).toBe('shedding');
      expect(resolveConfirmedBinaryCommandReasonCode(offPending({}))).toBe('shedding');
    });
  });
});
