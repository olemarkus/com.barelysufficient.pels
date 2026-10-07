/**
 * The arithmetic every home-battery stage shares: the battery's deadband, its
 * own charge and discharge, and whether a setpoint step is one it could
 * visibly answer; and whether PELS may drive it at all. The storage stage
 * (`storageRelief.ts`), the shedding candidate
 * (`lib/plan/shedding/storageCandidate.ts`), the limit step (`storageLimit.ts`)
 * and the restore hand-back all read the battery through these, so they agree
 * on what a step is worth and on which battery PELS may take over.
 */
import type {
  MissingStorageInput,
  ObservedStorageInput,
  StoragePlanInputKind,
} from '../../../packages/planner-types/src/planInputDevice';
import { storageSetpointToleranceW, type StorageReleaseReason } from '../../planContract/storageDecision';
import type { StorageLeverState } from '../planState';

/**
 * How long a battery limit's undelivered relief is credited: a discharge
 * increase to shedding's storage term, and the window after which a limit the
 * battery has not followed banks nothing more.
 */
export const STORAGE_RELIEF_SETTLE_WINDOW_MS = 30 * 1000;

/** The least headroom, W, that steps a setpoint down (also the headroom left behind). */
const STORAGE_MIN_DEADBAND_W = 200;

/** Type guard: the plan device carries a storage cluster (`StoragePlanInputKind`). */
export function hasStorageInput<T extends object>(device: T): device is T & StoragePlanInputKind {
  return 'storage' in device;
}

/**
 * Type guard: the plan device carries a storage cluster PELS has a lever on,
 * read (`observed`) or held but unread (`missing`). A battery PELS only
 * watches (`watched`) has none: the stages that hold, limit or hand back a
 * battery read it as one without a storage cluster.
 */
export function hasStorageLeverInput<T extends object>(
  device: T,
): device is T & { storage: ObservedStorageInput | MissingStorageInput } {
  return hasStorageInput(device) && device.storage.reading !== 'watched';
}

/** The battery's own discharge, W: 0 while it is idle or charging. */
export const ownDischargeWOf = (storage: Pick<ObservedStorageInput, 'signedPowerW'>): number => (
  Math.max(0, -storage.signedPowerW)
);

/**
 * Why PELS may not take this battery over, as the reason it hands back a hold
 * for: its verdict (`not_responding`, `sign_inverted`), not admissible
 * (Managed off, not the Main home, claim not recordable, or simulation), or
 * its Power-limit control off (`limit_off`; owner ruling, 2026-10-06: then
 * PELS never takes it over at all, with no charge cap, no discharge and no
 * surplus claim). `holdable` when none applies.
 */
export type StorageHoldBlock = Extract<
  StorageReleaseReason, 'not_responding' | 'sign_inverted' | 'not_admissible' | 'limit_off'
>;

/**
 * The one answer to "may PELS hold this battery": every battery stage asks it
 * here. A battery that is not holdable is no limit candidate, no surplus
 * claimant, and any hold on it is handed back.
 */
export function resolveStorageHoldBlock(storage: ObservedStorageInput): StorageHoldBlock | 'holdable' {
  if (storage.verdict === 'not_responding' || storage.verdict === 'sign_inverted') return storage.verdict;
  if (!storage.admissible) return 'not_admissible';
  if (!storage.powerLimitControl) return 'limit_off';
  return 'holdable';
}

/**
 * Whether PELS may drive the battery to a new setpoint now: holdable
 * (`resolveStorageHoldBlock`), and no hand-back of it running or waiting. A
 * hold PELS already has is kept while a hand-back is deferred; it is never
 * asked deeper, and no new claim starts.
 */
export function isStorageDrivable(storage: ObservedStorageInput): boolean {
  return resolveStorageHoldBlock(storage) === 'holdable' && !storage.handBackDeferred;
}

/** The battery's deadband, W: its step, and never less than `STORAGE_MIN_DEADBAND_W`. */
export const deadbandWFor = (storage: Pick<ObservedStorageInput, 'range'>): number => (
  Math.max(storage.range.stepW, STORAGE_MIN_DEADBAND_W)
);

/**
 * The import a battery's limit deliberately leaves under the house's draw, W:
 * half its deadband, so a discharge never tips the house into export. The
 * candidate bounds its ladder by it, the storage term reports it, and an
 * exhausted hour forgives it.
 */
export const drawMarginWFor = (storage: Pick<ObservedStorageInput, 'range'>): number => deadbandWFor(storage) / 2;

/** The battery's own charge, W: 0 while it is idle or discharging. */
export const ownChargeWOf = (storage: ObservedStorageInput): number => Math.max(0, storage.signedPowerW);

/**
 * The charge its own mode takes once handed back on top of what this hold
 * already lets through, W. A charge the hold lets through is on the meter
 * already, so only the rest is new draw; a discharge hold lets none through,
 * so it is the whole own-mode charge. The restore lane sizes a hand-back on
 * it (`lib/plan/restore/storageHandBack.ts`), and a charge limit names it as
 * the charge it holds back (`resolveHeldBackChargeW`).
 */
export const resolveOwnModeChargeAboveHoldW = (lever: StorageLeverState): number => (
  Math.max(0, lever.ownModeChargeW - Math.max(0, lever.setpointW))
);

/** Whether raising from `fromW` to `toW` (either side of 0 W) is a step the battery could visibly answer. */
export const isRaiseVisible = (storage: Pick<ObservedStorageInput, 'range'>, fromW: number, toW: number): boolean => (
  toW - fromW >= storageSetpointToleranceW(toW, storage.range.stepW)
);

/** Whether lowering from `fromW` to `toW` (either side of 0 W) is a step the battery could visibly answer. */
export const isLowerVisible = (storage: Pick<ObservedStorageInput, 'range'>, fromW: number, toW: number): boolean => (
  fromW - toW >= storageSetpointToleranceW(toW, storage.range.stepW)
);

/** The signed setpoint for a discharge, W: its negation, and a plain 0 rather than -0. */
export const toSetpointW = (dischargeW: number): number => (dischargeW === 0 ? 0 : -dischargeW);
