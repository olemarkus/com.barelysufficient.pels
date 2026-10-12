import {
  resolveBinaryShedReasonCode,
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
  describe('resolveBinaryShedReasonCode', () => {
    it('lifecycle release wins regardless of reason', () => {
      expect(resolveBinaryShedReasonCode(undefined, true)).toBe('lifecycle_release');
      expect(resolveBinaryShedReasonCode('swap', true)).toBe('lifecycle_release');
    });
    it('capacity shed uses shed_with_reason when a reason is present, else shedding', () => {
      expect(resolveBinaryShedReasonCode('swap', false)).toBe('shed_with_reason');
      expect(resolveBinaryShedReasonCode('swap', undefined)).toBe('shed_with_reason');
      expect(resolveBinaryShedReasonCode(undefined, false)).toBe('shedding');
      expect(resolveBinaryShedReasonCode(undefined, undefined)).toBe('shedding');
    });
  });

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

  // No-drift invariant: the deferred (confirmed) reason-code resolver must produce the
  // exact same OFF label as the shared helper the direct path uses. If either site stops
  // routing through resolveBinaryShedReasonCode this assertion diverges.
  describe('direct and deferred OFF reason-codes stay in lockstep', () => {
    const cases: { reason?: string; lifecycleRelease?: boolean }[] = [
      { lifecycleRelease: true },
      { reason: 'swap', lifecycleRelease: true },
      { reason: 'swap', lifecycleRelease: false },
      { reason: 'swap' },
      { lifecycleRelease: false },
      {},
    ];
    it.each(cases)('reason=%j', ({ reason, lifecycleRelease }) => {
      const direct = resolveBinaryShedReasonCode(reason, lifecycleRelease);
      const deferred = resolveConfirmedBinaryCommandReasonCode(
        offPending({ reason, lifecycleRelease }),
      );
      expect(deferred).toBe(direct);
    });
  });
});
