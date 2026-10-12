import type { ClassifiedPlanReason } from './planReasonStrings';
import type { PlanEngineState } from './planState';
import type { TemperatureSetpointsByDevice } from '../../packages/planner-types/src/temperatureSetpoints';
import type { RestorePlanResult } from './restore/types';
import type { SheddingPlan } from './shedding/types';
/** Local shape: the pending-restore countdown a hold names. */
export type PendingRestoreDelay = { remainingSec: number; countdownStartedAtMs: number; countdownTotalSec: number };

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
 * `applyShedTemperatureHold` resolves `pendingRestoreDelay` and the normalized
 * floors once; the rest is the two decisions the pass runs after, carried
 * whole. Each stage below once re-declared seventeen members inline, and the
 * pass itself later re-listed the restore result's timing, reservations and
 * restored set and the shedding plan's reasons and latch beside each other —
 * the inverse failure the root `AGENTS.md` names, a domain object the caller
 * already holds exploded into loose values on the way down.
 */
export type HoldPass = {
  readonly state: PlanEngineState;
  /**
   * The restore pass this lane runs after, whole: its effective `timing` (the
   * shed-window ladder `resolveOffDeviceReason`, the restore gate and the
   * meter-settling check all read it), its startup reservations, and the
   * devices it restored, which this lane neither admits again nor debits twice.
   */
  readonly restoreResult: RestorePlanResult;
  /**
   * This cycle's shedding decision: the fresh shed reasons, the guard's
   * shortfall, and its shedding latch — the restore pass forks on the latch
   * before its cooldown lane, and this lane must fork the same way.
   */
  readonly sheddingPlan: SheddingPlan;
  readonly pendingRestoreDelay: PendingRestoreDelay | null;
  readonly temperatureSetpoints: TemperatureSetpointsByDevice;
  readonly normalizedShedFloorCByDevice: ReadonlyMap<string, number>;
};

/** The running pair the per-device loop threads through the pass. */
export type HoldLoopState = {
  availableHeadroom: number | null;
  restoredOneThisCycle: boolean;
};

