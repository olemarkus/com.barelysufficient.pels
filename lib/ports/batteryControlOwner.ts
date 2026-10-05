import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';

/**
 * Why PELS may not claim a battery now:
 *
 * - `not_drivable` — the battery is not observed, or its control surface is
 *   not `setpoint`.
 * - `control_disabled` — the owner turned PELS's control of this battery off.
 * - `control_setting_unreadable` — the opt-out setting has never read cleanly
 *   (fail closed for a claim).
 * - `not_main_home` — the battery is not a Main-home member (v1 is Main only),
 *   or membership cannot be resolved.
 * - `actuation_fenced` — Main's write fence is closed.
 * - `dry_run` — capacity simulation is on: nothing may be written.
 * - `release_in_flight` — a hand-back of this battery is running.
 * - `claim_records_unread` — the claim records could not be listed, so PELS
 *   cannot tell whether it already owes this battery a hand-back.
 * - `claim_record_unreadable` — this battery's stored record does not parse.
 * - `claim_record_mismatch` — the stored record names a claim capability the
 *   battery no longer claims through.
 * - `claim_unobserved` — the battery has not reported its claim value, so there
 *   is nothing to record to hand back to.
 * - `held_by_other` — the battery is already under Homey's claim and PELS has
 *   no record of claiming it: someone else is driving it.
 * - `claim_value_undeclared` — the value to hand back to is not one the claim
 *   capability declares, so PELS could never restore it.
 * - `claim_record_unwritable` — the record could not be stored; claiming
 *   without it would leave a crash with nothing to recover.
 */
export type BatteryClaimRefusal =
  | 'not_drivable'
  | 'control_disabled'
  | 'control_setting_unreadable'
  | 'not_main_home'
  | 'actuation_fenced'
  | 'dry_run'
  | 'release_in_flight'
  | 'claim_records_unread'
  | 'claim_record_unreadable'
  | 'claim_record_mismatch'
  | 'claim_unobserved'
  | 'held_by_other'
  | 'claim_value_undeclared'
  | 'claim_record_unwritable';

export type BatteryClaimAdmission =
  | { status: 'admitted' }
  | { status: 'refused'; reason: BatteryClaimRefusal };

/**
 * The Main home's battery control owner (`lib/battery/batteryControlOwner.ts`):
 * claim admission, the durable claim record, and the hand-back. It issues no
 * setpoint; the executor does, through Main's fenced actuator, after
 * `admitClaim` admitted the battery.
 */
export type BatteryControlOwner = {
  /**
   * Must answer `admitted` before any `storage_power` intent reaches the
   * battery. Before the first admission it durably records the claim value the
   * battery holds, so a crash leaves something to hand back to.
   */
  admitClaim(deviceId: string): BatteryClaimAdmission;
  /**
   * A committed device snapshot: prunes the record of a battery gone from
   * Homey, and retries every hand-back that is due (boot recovery and failed
   * releases, with backoff).
   */
  onSnapshotCommitted(refresh: ObservedDeviceStateRefreshPayload): void;
  /** Re-read the owner's opt-out and hand back every claimed battery it now turns off. */
  applyControlSettings(): void;
};
