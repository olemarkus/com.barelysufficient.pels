/**
 * What a battery's claim shows against PELS's record of it, and whether a
 * hand-back of the record could succeed: the reads the battery control owner
 * (`batteryControlOwner.ts`, whose header says what each answer means) decides
 * admission, takeovers and hand-backs on, and the log of PELS's own claim
 * writes they are read against.
 */
import type { HomeBatteryClaimCapabilityId, HomeBatteryClaimObservation } from '../../packages/contracts/src/types';
import type { BatteryClaimRefusal, BatteryControlRead } from '../ports/batteryControlOwner';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../ports/controlCommandConfirmation';
import type { BatteryClaimRecord } from './batteryClaimStore';

export type SetpointBatteryRead = Extract<BatteryControlRead, { kind: 'setpoint' }>;

/**
 * A battery PELS can drive now: through a claim capability (`setpoint`), or
 * claim-less through its app's actions (`app_actions`), whose claim is PELS's
 * own record: it is always `held`, never contested or taken over, and nothing
 * it reports shows a landed hand-back.
 */
export type DrivableBatteryRead = Extract<BatteryControlRead, { kind: 'setpoint' } | { kind: 'app_actions' }>;

export const isDrivableBattery = (battery: BatteryControlRead): battery is DrivableBatteryRead => (
  battery.kind === 'setpoint' || battery.kind === 'app_actions'
);

/** Whether PELS drives the battery through its app's actions, on the owner's Homey API key, usable or not. */
export const runsOnHomeyApiKey = (battery: BatteryControlRead): boolean => (
  battery.kind === 'app_actions' || battery.kind === 'homey_api_key_missing'
);

/**
 * Why a hand-back can never succeed against the battery as it is now. An
 * app-action battery with no usable Homey API key (`homey_api_key_missing`)
 * is one until a key is saved: its hand-back actions cannot run before.
 */
export type TerminalReleaseFailure =
  | 'not_battery'
  | 'observe_only'
  | 'homey_api_key_missing'
  | 'capability_mismatch'
  | 'restore_value_undeclared';

/**
 * What the owner records before it first claims a battery: the claim
 * capability and the value it holds now, or, for a claim-less battery, only
 * that PELS holds it.
 */
export type ClaimToRecord =
  | { kind: 'claim_capability'; claim: HomeBatteryClaimObservation; capabilityId: HomeBatteryClaimCapabilityId }
  | { kind: 'app_actions' };

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
 * What to record before PELS first claims a battery: the claim value it
 * reports now, provided PELS could hand the battery back to it. A claim-less
 * battery has nothing to restore.
 */
export const resolveValueToRecord = (
  battery: DrivableBatteryRead,
): BatteryClaimRefusal | ClaimToRecord => {
  if (battery.kind === 'app_actions') return { kind: 'app_actions' };
  const { surface, claim } = battery;
  if ('kind' in claim) return 'claim_unobserved';
  if (claim.value === surface.claim.homeyValue) return 'held_by_other';
  if (!surface.claim.values.includes(claim.value)) return 'claim_value_undeclared';
  return { kind: 'claim_capability', claim, capabilityId: surface.claim.capabilityId };
};

/** The record of a claim admitted at `claimedAtMs`. */
export const toClaimRecord = (value: ClaimToRecord, claimedAtMs: number): BatteryClaimRecord => (
  value.kind === 'app_actions'
    ? { kind: 'app_actions', claimedAtMs }
    : { kind: 'claim_capability', capabilityId: value.capabilityId, previousValue: value.claim.value, claimedAtMs }
);

/** Whether the record describes the binding the battery has now: the same claim capability, or app actions. */
export const isRecordOfBinding = (record: BatteryClaimRecord, battery: DrivableBatteryRead): boolean => (
  battery.kind === 'app_actions'
    ? record.kind === 'app_actions'
    : record.kind === 'claim_capability' && record.capabilityId === battery.surface.claim.capabilityId
);

/** Why no hand-back could ever succeed against the battery as it is now; `undefined` when one could. */
export const resolveTerminalFailure = (
  record: BatteryClaimRecord,
  battery: Exclude<BatteryControlRead, { kind: 'unobserved' }>,
): TerminalReleaseFailure | undefined => {
  if (!isDrivableBattery(battery)) return battery.kind;
  if (!isRecordOfBinding(record, battery)) return 'capability_mismatch';
  if (battery.kind === 'app_actions' || record.kind !== 'claim_capability') return undefined;
  return battery.surface.claim.values.includes(record.previousValue) ? undefined : 'restore_value_undeclared';
};

/** The value a record hands the battery back to, for the log: the recorded claim value, or its app's own mode. */
export const describeHandBack = (record: BatteryClaimRecord): string => (
  record.kind === 'claim_capability' ? record.previousValue : 'app_actions'
);

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
    if (record.kind !== 'claim_capability' || 'kind' in claim || claim.value !== record.previousValue) return false;
    const restoredAtMs = this.restoredAtMs.get(deviceId);
    if (restoredAtMs !== undefined) return claim.observedAtMs > restoredAtMs;
    return bootRecovery && this.readStanding(deviceId, record, battery, nowMs) !== 'held';
  }

  forget(deviceId: string): void {
    this.writtenAtMs.delete(deviceId);
    this.restoredAtMs.delete(deviceId);
  }

  /** A claim-less battery reports no claim, so its record stands as `held`. */
  readStanding(
    deviceId: string,
    record: BatteryClaimRecord,
    battery: DrivableBatteryRead,
    nowMs: number,
  ): ClaimStanding {
    if (battery.kind === 'app_actions' || record.kind !== 'claim_capability') return 'held';
    const { claim, surface } = battery;
    if (surface.claim.capabilityId !== record.capabilityId || 'kind' in claim) return 'held';
    // No claim write yet this run: the record's claim time is the last one known.
    const lastWriteMs = this.writtenAtMs.get(deviceId) ?? record.claimedAtMs;
    if (claim.value === surface.claim.homeyValue || claim.observedAtMs <= lastWriteMs) return 'held';
    return nowMs - lastWriteMs < CONTROL_COMMAND_CONFIRMATION_MS ? 'contested' : 'taken_over';
  }
}
