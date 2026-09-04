import type { ClassifiedPlanReason } from './planReasonStrings';
import type { PlanEngineState } from './planState';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { HeadroomReserve } from './admission';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { OffDeviceReasonTiming } from './restore/devices';
/** Local shape: the pending-restore countdown a hold names. */
export type PendingRestoreDelay = { remainingSec: number; countdownStartedAtMs: number; countdownTotalSec: number };
import type { RestoreCooldownPreviewState } from './planReasonsRestoreGating';

export function shouldNormalizeReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'none'
    || reason.code === 'keep'
    || reason.code === 'restore_need';
}

export function isSwapReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'swap_pending' || reason.code === 'swapped_out';
}

export function isBudgetReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'hourly_budget' || reason.code === 'daily_budget';
}

export function isShortfallReason(reason: ClassifiedPlanReason): boolean {
  return reason.code === 'shortfall';
}

/**
 * One shed-temperature hold pass, as every stage of it sees the pass.
 *
 * `applyShedTemperatureHold` already resolves all of this once — `offDeviceTiming`,
 * `pendingRestoreDelay` and `cooldownPreviewState` are derived there, the rest
 * comes straight off `ShedHoldParams`. Before this type each stage below
 * re-declared the same seventeen members inline: `resolveHoldDecision` declared
 * 18 and read 3, `applyHoldToDevice` declared 18 and read 4, and the two lists
 * were identical but for the `behavior` type. That is the inverse failure the
 * root `AGENTS.md` names — a domain object the caller already holds, exploded
 * into loose values on the way down.
 */
export type HoldPass = {
  readonly state: PlanEngineState;
  readonly shedReasons: Map<string, DeviceReason>;
  readonly inShedWindow: boolean;
  readonly offDeviceTiming: OffDeviceReasonTiming;
  readonly holdDuringRestoreCooldown: boolean;
  readonly restoreCooldownSeconds: number;
  readonly restoreCooldownRemainingSec: number | null;
  readonly pendingRestoreDelay: PendingRestoreDelay | null;
  /** Empty rather than absent: no reservations is a value, not a missing input. */
  readonly headroomReserves: readonly HeadroomReserve[];
  readonly guardInShortfall: boolean;
  readonly normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
  readonly restoredThisCycle: Set<string>;
  readonly debugStructured?: StructuredDebugEmitter;
  readonly cooldownPreviewState?: RestoreCooldownPreviewState;
};

/** The running pair the per-device loop threads through the pass. */
export type HoldLoopState = {
  availableHeadroom: number;
  restoredOneThisCycle: boolean;
};

