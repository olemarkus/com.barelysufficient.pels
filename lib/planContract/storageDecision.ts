/**
 * The planner's decision for a home battery, as the executor's storage lane
 * reads it off the plan device (`lib/executor/batteryExecutor.ts`). Decided by
 * the storage stages in `lib/plan/battery/` (the battery's limit chosen by
 * shedding at its place in the priority order, its surplus hold, and its
 * hand-backs); a battery the plan is not driving and holds no claim on carries
 * no decision at all.
 *
 * - `setpoint` — hold the battery at the desired signed power, W. Idle is
 *   0 W and keeps the claim. `stepW` sizes confirmation tolerance.
 * - `release` — hand the battery back to its own mode after an opt-out or
 *   a loss of safe control. Historical reasons remain readable.
 */
export type StorageReleaseReason =
  | 'restored'
  | 'limit_off'
  | 'idle'
  | 'surplus_dwell'
  | 'full'
  | 'meter_silent'
  | 'input_missing'
  | 'not_admissible'
  | 'not_responding'
  | 'sign_inverted';

export type StorageDecision =
  | { kind: 'setpoint'; setpointW: number; stepW: number; restored?: true }
  | { kind: 'release'; reason: StorageReleaseReason };

/** Hand-back remains executable when its battery no longer has a plan device. */
export type StorageReleaseIntent = { deviceId: string; reason: StorageReleaseReason };

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
