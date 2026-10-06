/**
 * What a battery's claim shows against PELS's record of it, and whether a
 * hand-back of the record could succeed: the reads the battery control owner
 * (`batteryControlOwner.ts`, whose header says what each answer means) decides
 * admission, takeovers and hand-backs on, and the log of PELS's own claim
 * writes they are read against.
 */
import type { HomeBatteryClaimObservation } from '../../packages/contracts/src/types';
import type { BatteryClaimRefusal, BatteryControlRead } from '../ports/batteryControlOwner';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../ports/controlCommandConfirmation';
import type { BatteryClaimRecord } from './batteryClaimStore';

export type SetpointBatteryRead = Extract<BatteryControlRead, { kind: 'setpoint' }>;

/** Why a hand-back can never succeed against the battery as it is now. */
export type TerminalReleaseFailure =
  | 'not_battery'
  | 'observe_only'
  | 'capability_mismatch'
  | 'restore_value_undeclared';

/**
 * What a hand-back attempt would do to the battery as it is now: the write
 * (`release`), nothing because PELS's own earlier hand-back already landed
 * (`handed_back`), wait while the claim is contested, nothing because someone
 * else took the battery over (`superseded`), or nothing it could ever do.
 */
export type ReleaseVerdict =
  | { kind: 'release' }
  | { kind: 'handed_back' }
  | { kind: 'contested' }
  | { kind: 'superseded' }
  | { kind: 'terminal'; failure: TerminalReleaseFailure };

/**
 * What a battery's claim shows against PELS's record of it: `held` (Homey's
 * value, no value, a claim through another capability, or another value
 * reported no later than PELS's last claim write), `contested` (another value
 * reported after that write, inside the confirmation window), or `taken_over`
 * (another value reported after that write, read once the window is over).
 */
export type ClaimStanding = 'held' | 'contested' | 'taken_over';

/** Whether the battery reports Homey's claim value: under a claim, PELS's or anyone's. */
export const isClaimEngaged = (battery: SetpointBatteryRead): boolean => (
  !('kind' in battery.claim) && battery.claim.value === battery.surface.claim.homeyValue
);

/**
 * The claim value to record before PELS first claims a battery: the one it
 * reports now, provided PELS could hand the battery back to it.
 */
export const resolveValueToRecord = (
  battery: SetpointBatteryRead,
): BatteryClaimRefusal | HomeBatteryClaimObservation => {
  const { surface, claim } = battery;
  if ('kind' in claim) return 'claim_unobserved';
  if (claim.value === surface.claim.homeyValue) return 'held_by_other';
  if (!surface.claim.values.includes(claim.value)) return 'claim_value_undeclared';
  return claim;
};

/** Why no hand-back could ever succeed against the battery as it is now; `undefined` when one could. */
export const resolveTerminalFailure = (
  record: BatteryClaimRecord,
  battery: Exclude<BatteryControlRead, { kind: 'unobserved' }>,
): TerminalReleaseFailure | undefined => {
  if (battery.kind !== 'setpoint') return battery.kind;
  const { claim } = battery.surface;
  if (claim.capabilityId !== record.capabilityId) return 'capability_mismatch';
  return claim.values.includes(record.previousValue) ? undefined : 'restore_value_undeclared';
};

/**
 * When PELS last wrote each recorded battery's claim this run, and each
 * battery's claim standing against it. Before the first write of a run, the
 * record's claim time stands for it. Also when PELS last issued each
 * battery's hand-back restore this run: only a report after it can show that
 * hand-back landed.
 */
export class ClaimWriteLog {
  private readonly writtenAtMs = new Map<string, number>();
  private readonly restoredAtMs = new Map<string, number>();

  noteWrite(deviceId: string, nowMs: number): void {
    this.writtenAtMs.set(deviceId, nowMs);
  }

  noteRestore(deviceId: string, nowMs: number): void {
    this.restoredAtMs.set(deviceId, nowMs);
  }

  /**
   * Whether the battery reports the value PELS would restore because PELS's
   * own hand-back landed, whatever its write reported: the report is dated
   * after a restore PELS issued this run, or, before any this run, the record
   * is a boot recovery's (`bootRecovery`: a record whose delete failed
   * outlives the hand-back it recorded) and the report is dated after its
   * claim. A report with no hand-back behind it is not one: on a first claim,
   * the battery app's stale echo of its own mode IS the value PELS would
   * restore.
   */
  showsLandedHandBack(
    deviceId: string,
    record: BatteryClaimRecord,
    battery: SetpointBatteryRead,
    bootRecovery: boolean,
    nowMs: number,
  ): boolean {
    const { claim } = battery;
    if ('kind' in claim || claim.value !== record.previousValue) return false;
    const restoredAtMs = this.restoredAtMs.get(deviceId);
    if (restoredAtMs !== undefined) return claim.observedAtMs > restoredAtMs;
    return bootRecovery && this.readStanding(deviceId, record, battery, nowMs) !== 'held';
  }

  forget(deviceId: string): void {
    this.writtenAtMs.delete(deviceId);
    this.restoredAtMs.delete(deviceId);
  }

  readStanding(
    deviceId: string,
    record: BatteryClaimRecord,
    battery: SetpointBatteryRead,
    nowMs: number,
  ): ClaimStanding {
    const { claim, surface } = battery;
    if (surface.claim.capabilityId !== record.capabilityId || 'kind' in claim) return 'held';
    // No claim write yet this run: the record's claim time is the last one known.
    const lastWriteMs = this.writtenAtMs.get(deviceId) ?? record.claimedAtMs;
    if (claim.value === surface.claim.homeyValue || claim.observedAtMs <= lastWriteMs) return 'held';
    return nowMs - lastWriteMs < CONTROL_COMMAND_CONFIRMATION_MS ? 'contested' : 'taken_over';
  }
}
