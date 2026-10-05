/**
 * The planner's decision for a home battery, as the executor's storage lane
 * reads it off the plan device (`lib/executor/batteryExecutor.ts`). Decided by
 * the storage relief stage (`lib/plan/battery/storageRelief.ts`); a battery the
 * plan is not driving and holds no claim on carries no decision at all.
 *
 * - `setpoint` — hold the battery at this signed power, W (negative
 *   discharges; this slice never charges). `stepW` is the battery's setpoint
 *   grid, which the executor's confirmation tolerance is sized against.
 * - `release` — hand the battery back to its own mode.
 */
export type StorageReleaseReason =
  | 'idle'
  | 'meter_silent'
  | 'input_missing'
  | 'not_admissible'
  | 'not_responding'
  | 'sign_inverted';

export type StorageDecision =
  | { kind: 'setpoint'; setpointW: number; stepW: number }
  | { kind: 'release'; reason: StorageReleaseReason };

/**
 * The plan-device cluster that carries it. Omitted from the plan device base,
 * like the other orthogonal clusters: reach it through `hasStorageDecision`.
 */
export type StoragePlanKind = { storageDecision: StorageDecision };

/**
 * A plan device carrying a storage decision, as the executor reads it: the
 * identity it logs and writes against, and the decision. Every plan device
 * with a storage decision satisfies it.
 */
export type StorageDecidedDevice = { id: string; name: string } & StoragePlanKind;

export function hasStorageDecision<T extends object>(device: T): device is T & StoragePlanKind {
  return 'storageDecision' in device;
}

/** The least tolerance a battery setpoint is judged within, W. */
const MIN_SETPOINT_TOLERANCE_W = 150;
/** The tolerance as a share of the setpoint. */
const SETPOINT_TOLERANCE_RATIO = 0.1;

/**
 * How close a battery's own power must come to a setpoint to have reached it,
 * W: `max(step, 150 W, 10 %)`. The executor confirms setpoints within it, and
 * the planner raises a setpoint only by at least this much, so a raise is
 * always one the battery can visibly answer.
 */
export function storageSetpointToleranceW(setpointW: number, stepW: number): number {
  return Math.max(stepW, MIN_SETPOINT_TOLERANCE_W, Math.abs(setpointW) * SETPOINT_TOLERANCE_RATIO);
}
