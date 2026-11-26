/**
 * Return a capacity-limited battery to managed idle at its turn in the
 * restore order. The headroom ledger has already withheld its discharge,
 * and a later measured cycle admits routine solar or economic operation.
 */
import { phaseRoomFor, phaseShare } from '../phase/phaseRoom';
import { spendPowerHeadroom } from '../powerLimitMath';
import type { DevicePlanDevice } from '../planTypes';
import type { StorageLeverState } from '../planState';
import { emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { buildReserveAdmittedLogFields, resolveReserveAdmission } from '../admission';
import { canAdmitWithinBatch, canAttemptBatchContinuation, recordBatchAdmission } from './batch';
import { shouldWaitForOtherRecovery } from './coordination';
import {
  buildRestoreEvidenceLogFields,
  inCycleRestoreWait, otherRecoveryWait, resolveCapacityRestoreBlockReason, resolveMeterSettlingReason,
} from './timing';
import type { RestoreCycle, RestoreLoopState } from './types';

function exportRoomFits(
  cycle: RestoreCycle,
  device: DevicePlanDevice,
  increaseW: number,
): boolean {
  if (increaseW <= 0) return true;
  return (['L1', 'L2', 'L3'] as const).every((phase) => {
    const neededKw = increaseW * phaseShare(device.phaseFootprint, phase) / 1000;
    const availableKw = cycle.readPhaseExportRoomKw(phase);
    return neededKw === 0 || availableKw === null || availableKw >= neededKw;
  });
}

function phaseRestoreBlock(
  cycle: RestoreCycle,
  device: DevicePlanDevice,
  lever: StorageLeverState,
): 'phase_import' | 'phase_export' | null {
  if (lever.exportPhase === undefined) return null;
  // Admission power already debits all held or observed discharge, including
  // its phase share. The phase axis also withholds its usual clear band.
  const phaseRoom = phaseRoomFor(cycle.readPhaseRoom(), device.phaseFootprint);
  if (phaseRoom.kind === 'on' && phaseRoom.kw < 0) return 'phase_import';
  return exportRoomFits(cycle, device, lever.economicResumeIncreaseW ?? 0) ? null : 'phase_export';
}

/** Restore a battery to managed idle if the lane admits it now. */
export function planStorageHandBack(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  lever: StorageLeverState,
  loop: RestoreLoopState,
): RestoreLoopState {
  const { state, deviceMap, timing, batchState, headroomReserves, phase } = cycle;
  const { availableHeadroom, restoredOneThisCycle } = loop;
  // A positive held charge can drop to idle without needing import room.
  // An active discharge must first be eased to zero by the storage stage.
  if (lever.setpointW < 0 && lever.exportPhase === undefined) return loop;
  const debugKey = `storage:${dev.id}`;
  const reject = (rejectionReason: string): RestoreLoopState => {
    emitRestoreDebugEventOnChange(state, debugKey, {
      event: 'restore_rejected',
      restoreType: 'storage',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      neededKw: 0,
      availableKw: availableHeadroom,
      decision: 'rejected',
      rejectionReason,
      ...buildRestoreEvidenceLogFields(timing),
    });
    return loop;
  };

  const phaseBlock = phaseRestoreBlock(cycle, dev, lever);
  if (phaseBlock !== null) return reject(phaseBlock);

  const batchContinuation = restoredOneThisCycle && canAttemptBatchContinuation(batchState);
  const blockedByInCycleRestore = restoredOneThisCycle && !batchContinuation;
  if (resolveMeterSettlingReason(timing, state.actuation.lastRestoreMs, blockedByInCycleRestore) !== null) {
    return reject('meter_settling');
  }
  // A restore already admitted this cycle is checked before other devices still recovering.
  const gateReason = resolveCapacityRestoreBlockReason(
    timing,
    inCycleRestoreWait(blockedByInCycleRestore)
      ?? otherRecoveryWait(shouldWaitForOtherRecovery(deviceMap, dev.id, batchContinuation)),
    true,
  );
  if (gateReason) return reject(gateReason.code);

  const neededKw = 0;
  if (batchContinuation && !canAdmitWithinBatch(batchState, neededKw)) return reject('batch_full');
  const reserved = resolveReserveAdmission(dev, availableHeadroom, neededKw, headroomReserves);
  if (reserved.kind === 'blocked_by_reserve') return reject('reserved_for_start');
  if (reserved.kind === 'insufficient') {
    // Waiting for room: the restores ranked below it wait behind it, as they
    // would behind a waiting load, so a smaller one never takes the room first.
    // eslint-disable-next-line no-param-reassign, functional/immutable-data -- the pass's own running fact
    cycle.storageHandBackWaitingAt = Math.min(cycle.storageHandBackWaitingAt, dev.priority);
    return reject('insufficient_headroom');
  }
  emitRestoreDebugEventOnChange(state, debugKey, {
    event: 'restore_admitted',
    restoreType: 'storage',
    deviceId: dev.id,
    deviceName: dev.name,
    phase,
    neededKw,
    availableKw: buildReserveAdmittedLogFields(reserved).effectiveHeadroomKw,
    decision: 'admitted',
    ...buildRestoreEvidenceLogFields(timing),
  });
  cycle.storageHandedBack.add(dev.id);
  recordBatchAdmission(batchState, neededKw);
  return { availableHeadroom: spendPowerHeadroom(availableHeadroom, neededKw), restoredOneThisCycle: true };
}

/** Whether a battery hand-back ranked above this device is waiting for room this pass. */
export function isBehindWaitingHandBack(cycle: RestoreCycle, dev: Pick<DevicePlanDevice, 'priority'>): boolean {
  return cycle.storageHandBackWaitingAt < dev.priority;
}
