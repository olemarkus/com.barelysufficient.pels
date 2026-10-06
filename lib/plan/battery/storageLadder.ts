/**
 * The arithmetic every home-battery stage shares: the battery's deadband, its
 * own charge and discharge, and whether a setpoint step is one it could
 * visibly answer. The storage stage (`storageRelief.ts`), the shedding
 * candidate (`lib/plan/shedding/storageCandidate.ts`), the limit step
 * (`storageLimit.ts`) and the restore hand-back all read the battery through
 * these, so they agree on what a step is worth.
 */
import type {
  ObservedStorageInput,
  StoragePlanInputKind,
} from '../../../packages/planner-types/src/planInputDevice';
import { storageSetpointToleranceW } from '../../planContract/storageDecision';

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

/** The battery's deadband, W: its step, and never less than `STORAGE_MIN_DEADBAND_W`. */
export const deadbandWFor = (storage: Pick<ObservedStorageInput, 'stepW'>): number => (
  Math.max(storage.stepW, STORAGE_MIN_DEADBAND_W)
);

/**
 * The import a battery's limit deliberately leaves under the house's draw, W:
 * half its deadband, so a discharge never tips the house into export. The
 * candidate bounds its ladder by it, the storage term reports it, and an
 * exhausted hour forgives it.
 */
export const drawMarginWFor = (storage: Pick<ObservedStorageInput, 'stepW'>): number => deadbandWFor(storage) / 2;

/** The battery's own charge, W: 0 while it is idle or discharging. */
export const ownChargeWOf = (storage: ObservedStorageInput): number => Math.max(0, storage.signedPowerW);

/** The battery's own discharge, W: 0 while it is idle or charging. */
export const ownDischargeWOf = (storage: ObservedStorageInput): number => Math.max(0, -storage.signedPowerW);

/** Whether raising from `fromW` to `toW` (either side of 0 W) is a step the battery could visibly answer. */
export const isRaiseVisible = (storage: Pick<ObservedStorageInput, 'stepW'>, fromW: number, toW: number): boolean => (
  toW - fromW >= storageSetpointToleranceW(toW, storage.stepW)
);

/** Whether lowering from `fromW` to `toW` (either side of 0 W) is a step the battery could visibly answer. */
export const isLowerVisible = (storage: Pick<ObservedStorageInput, 'stepW'>, fromW: number, toW: number): boolean => (
  fromW - toW >= storageSetpointToleranceW(toW, storage.stepW)
);

/** The signed setpoint for a discharge, W: its negation, and a plain 0 rather than -0. */
export const toSetpointW = (dischargeW: number): number => (dischargeW === 0 ? 0 : -dischargeW);
