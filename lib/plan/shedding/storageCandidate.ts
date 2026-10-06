/**
 * A home battery as a shed candidate (owner ruling, 2026-10-06): its charging
 * is a ranked load, and its limiting ladder runs from its charge, through 0 W,
 * to its deepest discharge, at its own place in the priority order. Devices
 * ranked below it are limited first; its discharge protects only the devices
 * ranked above it. Last in the order (the default), it covers the house before
 * any device is limited.
 *
 * One candidate covers both halves, so a charging battery facing a deficit
 * caps its charge and then discharges in one decision: its relief is priced
 * from where it is (`baseW`) down to its delivery ceiling, bounded by the
 * house's draw less the margin its limit leaves under it (`drawMarginWFor`), so
 * the limit never tips the house into export.
 *
 * Offered only when PELS may limit it: Managed and Power-limit control on, its
 * storage read (`isStorageLimitScope`), and drivable now (`isStorageDrivable`,
 * `lib/plan/battery/storageLadder.ts`).
 * A re-probing battery is still asked, but banks nothing
 * (`unconfirmedRelief`), so shedding goes on as without it; so is a battery
 * that has not followed its limit within the credit's window, as an
 * unconfirmed load command is. An unconfirmed battery PELS already holds is
 * held where it is, never asked deeper (`selection.ts`). The battery is never
 * in the shed set: the setpoint it is spent at leaves shedding through
 * `storageSetpoints`.
 */
import type { PlanInputDevice } from '../planTypes';
import type { ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';
import type { StorageLeverState } from '../planState';
import {
  STORAGE_RELIEF_SETTLE_WINDOW_MS,
  drawMarginWFor,
  hasStorageInput,
  isLowerVisible,
  isStorageDrivable,
} from '../battery/storageLadder';
import { storageSetpointToleranceW } from '../../planContract/storageDecision';
import { floorStorageSetpointW, toTargetPowerCapabilityValue } from '../../utils/storageSetpoint';
import type { StorageShedCandidate } from './types';

/** Why a battery in limit scope is not a candidate, for the skip log. */
export type StorageCandidateSkip = 'storage_not_drivable' | 'storage_nothing_to_release';

/** A battery whose limit is the owner's to give, read this cycle. */
export type LimitableStorageDevice = PlanInputDevice & { storage: ObservedStorageInput };

/**
 * Whether this device is a home battery whose limit is the owner's to give:
 * Managed and Power-limit control on, and its storage read. A battery that is
 * not is outside candidate scope, like a load PELS may not command.
 */
export function isStorageLimitScope(device: PlanInputDevice): device is LimitableStorageDevice {
  return hasStorageInput(device)
    && device.storage.reading === 'observed'
    && device.control.managed
    && device.storage.powerLimitControl;
}

/** Whether a battery in limit scope can be limited this cycle: shedding asks this of the cycle, not of candidacy. */
export function isDrivableLimitScope(device: PlanInputDevice): device is LimitableStorageDevice {
  return isStorageLimitScope(device) && isStorageDrivable(device.storage);
}

/**
 * A limit hold the battery has not followed since shedding last chose it, past
 * the credit's window: its own power still above the setpoint by more than a
 * visible step. Its relief is credited nowhere any more, so it banks nothing.
 */
const isLimitUnanswered = (
  storage: ObservedStorageInput,
  lever: StorageLeverState | undefined,
  nowTs: number,
): boolean => (
  lever !== undefined
  && lever.purpose === 'limit'
  && nowTs - lever.lastNeedAtMs >= STORAGE_RELIEF_SETTLE_WINDOW_MS
  && isLowerVisible(storage, storage.signedPowerW, lever.setpointW)
);

/** The battery's candidate, or why it offers nothing this cycle. */
export function buildStorageCandidate(
  device: LimitableStorageDevice,
  /** The hold PELS keeps on it after this cycle's storage stage, if any. */
  lever: StorageLeverState | undefined,
  /** The measured whole-home draw, kW: its discharge never tips the house into export. */
  drawKw: number,
  recentlyRestored: boolean,
  nowTs: number,
): StorageShedCandidate | StorageCandidateSkip {
  const { storage } = device;
  if (!isStorageDrivable(storage)) return 'storage_not_drivable';
  // A hold already decided is credited (pending relief for a stopped charge,
  // the storage term for a discharge still settling): the ladder starts below it.
  const baseW = lever === undefined ? storage.signedPowerW : Math.min(storage.signedPowerW, lever.setpointW);
  // The draw once the held part lands, less the margin the limit leaves under it.
  const drawAfterHeldW = drawKw * 1000 - (storage.signedPowerW - baseW);
  const maxReliefW = Math.max(0, Math.min(baseW + storage.deliveryCeilingW, drawAfterHeldW - drawMarginWFor(storage)));
  if (!isLowerVisible(storage, baseW, baseW - maxReliefW)) return 'storage_nothing_to_release';
  return {
    kind: 'storage',
    id: device.id,
    name: device.name,
    priority: device.priority,
    effectivePower: maxReliefW / 1000,
    recentlyRestored,
    unconfirmedRelief: storage.verdict === 'reprobing' || isLimitUnanswered(storage, lever, nowTs),
    hold: lever !== undefined && lever.purpose === 'limit'
      ? { kind: 'limit', setpointW: lever.setpointW }
      : { kind: 'none' },
    storage,
    baseW,
  };
}

/**
 * At least `openW`, and enough for a step the battery could visibly answer:
 * the tolerance grows with the setpoint it is judged at, so it is settled in a
 * few rounds, with a grid step to spare for the snap.
 */
const resolveVisibleReliefW = (storage: ObservedStorageInput, baseW: number, openW: number): number => {
  let reliefW = openW;
  for (let round = 0; round < 3; round += 1) {
    reliefW = Math.max(openW, storageSetpointToleranceW(baseW - reliefW, storage.range.stepW) + storage.range.stepW);
  }
  return reliefW;
};

/** What limiting a battery is spent for: its setpoint, the relief, and the stopped-charge part of it. */
export type StorageSpend = {
  setpointW: number;
  reliefKw: number;
  /**
   * The part of the relief that is charge stopped, kW: credited through pending
   * relief, because the battery's own reading shows it falling. The rest is
   * discharge, credited through the storage term while it settles.
   */
  chargeReliefKw: number;
};

/**
 * The setpoint that covers what is still open, plus the margin the limit
 * leaves as the increase's hysteresis, and at least a step the battery could
 * visibly answer; within the candidate's ladder. Snapped to the battery's grid
 * (nearest, so a discharge is not rounded short of the deficit, then floored
 * if that ran past the ladder). Null when the battery could not visibly answer
 * what is left.
 */
export function resolveStorageSpend(candidate: StorageShedCandidate, remainingKw: number): StorageSpend | null {
  const { storage, baseW } = candidate;
  const maxReliefW = candidate.effectivePower * 1000;
  const openW = remainingKw * 1000 + drawMarginWFor(storage);
  const wantedW = Math.min(maxReliefW, resolveVisibleReliefW(storage, baseW, openW));
  let setpointW = toTargetPowerCapabilityValue(baseW - wantedW, storage.range);
  if (baseW - setpointW > maxReliefW) setpointW = floorStorageSetpointW(baseW - maxReliefW, storage.range);
  if (!isLowerVisible(storage, baseW, setpointW)) return null;
  const reliefW = baseW - setpointW;
  return {
    setpointW,
    reliefKw: reliefW / 1000,
    chargeReliefKw: (Math.max(0, baseW) - Math.max(0, setpointW)) / 1000,
  };
}
