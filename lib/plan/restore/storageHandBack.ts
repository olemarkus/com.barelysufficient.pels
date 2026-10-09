/**
 * Restoring a home battery is handing it back (owner ruling, 2026-10-06). A
 * battery PELS holds for the limit (its charge capped, or discharging) leaves
 * that hold only here, in priority order with every other restore, under the
 * same gates: the startup and shed/restore cooldowns, meter settling, one
 * restore per cycle unless a batch is open, devices still recovering, startup
 * reservations, and the headroom its own mode takes once it charges again.
 *
 * The lane runs on the admission headroom, which already withholds the
 * discharge PELS holds (`withoutStorageWithheld`), so that discharge is never
 * spent on a hand-back: the battery steps its discharge down on headroom first
 * (`lib/plan/battery/storageRelief.ts`), and is handed back once the house has
 * room for the charge its own mode takes.
 *
 * A hand-back waiting for room holds back every restore ranked below it
 * (`isBehindWaitingHandBack`): a smaller device lower in the order would
 * otherwise take the room first, every cycle, and the battery never swaps.
 *
 * The hand-back is sized as the charge its own mode takes once handed back
 * (`StorageLeverState.ownModeChargeW`) above what the hold already lets
 * through (`resolveOwnModeChargeAboveHoldW`): a battery capped at a charge
 * already draws it on the meter, so only the rest is new. A discharge hold
 * lets no charge through, so it needs the whole own-mode charge; the discharge
 * PELS holds is withheld from restore already, so the hand-back never spends
 * it.
 *
 * The battery is not a load: nothing here touches its plan device. A hand-back
 * the lane admits joins `storageHandedBack`, and the battery stage releases
 * the hold (`applyStorageHandBacks`, reason `restored`).
 */
import { spendPowerHeadroom } from '../powerLimitMath';
import type { DevicePlanDevice } from '../planTypes';
import type { StorageLeverState } from '../planState';
import { emitRestoreDebugEventOnChange } from '../planDebugDedupe';
import { resolveOwnModeChargeAboveHoldW } from '../battery/storageLadder';
import { buildReserveAdmittedLogFields, resolveReserveAdmission } from '../admission';
import { computeRestoreBufferKw } from './accounting';
import { canAdmitWithinBatch, canAttemptBatchContinuation, recordBatchAdmission } from './batch';
import { shouldWaitForOtherRecovery } from './coordination';
import { resolveCapacityRestoreBlockReason, resolveMeterSettlingReason } from './timing';
import type { RestoreCycle, RestoreLoopState } from './types';

/** Hand the battery back if the lane admits it now: its limit hold (`resolveStorageHandBack`). */
export function planStorageHandBack(
  cycle: RestoreCycle,
  dev: DevicePlanDevice,
  lever: StorageLeverState,
  loop: RestoreLoopState,
): RestoreLoopState {
  const { state, deviceMap, timing, batchState, headroomReserves, phase } = cycle;
  const { availableHeadroom, restoredOneThisCycle } = loop;
  /** The charge its own mode adds once handed back, over what the hold lets through, kW. */
  const handBackChargeKw = resolveOwnModeChargeAboveHoldW(lever) / 1000;
  const debugKey = `storage:${dev.id}`;
  const reject = (rejectionReason: string): RestoreLoopState => {
    emitRestoreDebugEventOnChange({
      state,
      key: debugKey,
      payload: {
        event: 'restore_rejected',
        restoreType: 'storage',
        deviceId: dev.id,
        deviceName: dev.name,
        phase,
        neededKw: handBackChargeKw,
        availableKw: availableHeadroom,
        decision: 'rejected',
        rejectionReason,
      },
    });
    return loop;
  };

  const batchContinuation = restoredOneThisCycle && canAttemptBatchContinuation(batchState);
  const blockedByInCycleRestore = restoredOneThisCycle && !batchContinuation;
  if (resolveMeterSettlingReason(timing, state.actuation.lastRestoreMs, blockedByInCycleRestore) !== null) {
    return reject('meter_settling');
  }
  const gateReason = resolveCapacityRestoreBlockReason({
    timing,
    restoredOneThisCycle: blockedByInCycleRestore,
    waitingForOtherRecovery: shouldWaitForOtherRecovery(deviceMap, dev.id, batchContinuation),
  });
  if (gateReason) return reject(gateReason.code);

  const neededKw = handBackChargeKw + computeRestoreBufferKw(handBackChargeKw);
  if (batchContinuation && !canAdmitWithinBatch(batchState, neededKw)) return reject('batch_full');
  const reserved = resolveReserveAdmission({
    dev, availableHeadroom, neededKw, reserves: headroomReserves,
  });
  if (reserved.kind === 'blocked_by_reserve') return reject('reserved_for_start');
  if (reserved.kind === 'insufficient') {
    // Waiting for room: the restores ranked below it wait behind it, as they
    // would behind a waiting load, so a smaller one never takes the room first.
    // eslint-disable-next-line no-param-reassign, functional/immutable-data -- the pass's own running fact
    cycle.storageHandBackWaitingAt = Math.min(cycle.storageHandBackWaitingAt, dev.priority);
    return reject('insufficient_headroom');
  }
  emitRestoreDebugEventOnChange({
    state,
    key: debugKey,
    payload: {
      event: 'restore_admitted',
      restoreType: 'storage',
      deviceId: dev.id,
      deviceName: dev.name,
      phase,
      neededKw,
      availableKw: buildReserveAdmittedLogFields(reserved).effectiveHeadroomKw,
      decision: 'admitted',
    },
  });
  cycle.storageHandedBack.add(dev.id);
  recordBatchAdmission(batchState, neededKw);
  return { availableHeadroom: spendPowerHeadroom(availableHeadroom, neededKw), restoredOneThisCycle: true };
}

/** Whether a battery hand-back ranked above this device is waiting for room this pass. */
export function isBehindWaitingHandBack(cycle: RestoreCycle, dev: Pick<DevicePlanDevice, 'priority'>): boolean {
  return cycle.storageHandBackWaitingAt < dev.priority;
}
