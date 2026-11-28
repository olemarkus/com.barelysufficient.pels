/**
 * Price a battery's available electrical relief. The caller orders it with
 * the other candidates and can restrict the amount of discharge it spends.
 * Charge and discharge are parts of one signed setpoint. A meter-following
 * mode can stop charge at idle but does not accept a bounded discharge.
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
  STORAGE_RELIEF_SETTLE_WINDOW_MS, supportedDischargeCeilingW,
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

/** A battery that can accept bounded new discharge, including while at its current ceiling. */
export function isBoundedDischargeLimitScope(device: PlanInputDevice, neededKw: number): boolean {
  if (!isDrivableLimitScope(device)) return false;
  const { storage } = device;
  const ceilingW = supportedDischargeCeilingW(storage);
  return storage.canSetDischargePower
    || (ceilingW > 0 && Math.max(0, storage.signedPowerW) + ceilingW <= neededKw * 1000);
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

const storageBaseW = (storage: ObservedStorageInput, lever: StorageLeverState | undefined): number => {
  if (lever === undefined) return storage.signedPowerW;
  if (lever.purpose === 'continuous' && storage.signedPowerW < 0 && lever.setpointW > storage.signedPowerW) {
    return lever.setpointW;
  }
  return Math.min(storage.signedPowerW, lever.setpointW);
};

/** The battery's candidate, or why it offers nothing this cycle. */
export function buildStorageCandidate(
  device: LimitableStorageDevice,
  /** The hold PELS keeps on it after this cycle's storage stage, if any. */
  lever: StorageLeverState | undefined,
  /** The measured whole-home draw, kW: its discharge never tips the house into export. */
  drawKw: number,
  recentlyRestored: boolean,
  nowTs: number,
  /** Bound relief to its charge: the ladder stops at 0 W and never discharges. */
  chargeOnly = false,
): StorageShedCandidate | StorageCandidateSkip {
  const { storage } = device;
  if (!isStorageDrivable(storage)) return 'storage_not_drivable';
  // A hold already decided is credited (pending relief for a stopped charge,
  // the storage term for a discharge still settling): the ladder starts below it.
  // A continuous strategy may be withdrawing observed discharge. The storage
  // term already debits that pending import, so selection prices relief from
  // the proposed target rather than spending the old discharge a second time.
  const baseW = storageBaseW(storage, lever);
  // The draw once the held part lands, less the margin the limit leaves under it.
  const drawAfterHeldW = drawKw * 1000 - (storage.signedPowerW - baseW);
  const ceilingW = chargeOnly ? Math.max(0, baseW) : baseW + supportedDischargeCeilingW(storage);
  const maxReliefW = Math.max(0, Math.min(ceilingW, drawAfterHeldW - drawMarginWFor(storage)));
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
 * to nearest within the ladder and the shared room for additional discharge.
 * Meter-following chooses either a 0 W charge stop or its bounded full mode.
 * Returns null when the battery could not visibly answer what is left.
 */
export function resolveStorageSpend(
  candidate: StorageShedCandidate,
  remainingKw: number,
  dischargeRoomW = Infinity,
): StorageSpend | null {
  const { storage, baseW } = candidate;
  const maxReliefW = Math.min(candidate.effectivePower * 1000, Math.max(0, baseW) + dischargeRoomW);
  const minimumW = baseW - maxReliefW;

  const openW = remainingKw * 1000 + drawMarginWFor(storage);
  const wantedW = Math.min(maxReliefW, resolveVisibleReliefW(storage, baseW, openW));
  const setpointW = storage.canSetDischargePower
    ? snapStorageLimitW(baseW - wantedW, minimumW, storage.range)
    : resolveMeterFollowingSetpoint(storage, baseW, minimumW, remainingKw);
  if (setpointW < minimumW || !isLowerVisible(storage, baseW, setpointW)) return null;
  const reliefW = baseW - setpointW;
  return {
    setpointW,
    reliefKw: reliefW / 1000,
    chargeReliefKw: (Math.max(0, baseW) - Math.max(0, setpointW)) / 1000,
  };
}

function resolveMeterFollowingSetpoint(
  storage: ObservedStorageInput, baseW: number, minimumW: number, remainingKw: number,
): number {
  const fullW = -supportedDischargeCeilingW(storage);
  return fullW < 0 && fullW >= minimumW && baseW - fullW <= remainingKw * 1000 ? fullW : 0;
}

/** More relief from a candidate that has already been staged at a shallower target this build. */
export function storageCandidateBelow(
  candidate: StorageShedCandidate, stagedW: number,
): StorageShedCandidate {
  const baseW = Math.min(candidate.baseW, stagedW);
  const effectivePower = candidate.effectivePower - (candidate.baseW - baseW) / 1000;
  return { ...candidate, baseW, effectivePower };
}

/** Snap toward the safe side of the minimum, including a positive solar charge floor. */
function snapStorageLimitW(setpointW: number, minimumW: number, range: ObservedStorageInput['range']): number {
  const nearestW = toTargetPowerCapabilityValue(setpointW, range);
  if (nearestW >= minimumW) return nearestW;
  if (minimumW <= 0) return floorStorageSetpointW(minimumW, range);
  const safeStep = Math.ceil(Math.max(minimumW, range.excludeMaxW) / range.stepW);
  return toTargetPowerCapabilityValue(safeStep * range.stepW, range);
}
