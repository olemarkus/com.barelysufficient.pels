import type { HomeBatterySetpointRange } from '../../packages/contracts/src/types';
import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';
import type { StorageVerdict } from '../../packages/planner-types/src/planInputDevice';
import type { StorageReleaseReason } from '../planContract/storageDecision';

/** Re-exported so `lib/battery`, a leaf domain, names the plan's hand-back reasons through its port. */
export type { StorageReleaseReason } from '../planContract/storageDecision';

/**
 * Why PELS may not claim a battery now:
 *
 * - `not_drivable` — the battery is not observed, or its control surface is
 *   not `setpoint`.
 * - `control_disabled` — the owner turned PELS's control of this battery off.
 * - `claim_lost` — a newer observation shows another controller took over.
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
  | 'claim_lost'
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

/** Admission and the actual watts sent through the actuator, or a fenced write. */
export type BatterySetpointOutcome =
  | { status: 'refused'; reason: BatteryClaimRefusal }
  | { status: 'dispatched'; setpointW: number | 'skipped' };

/**
 * A battery's lever as the owner reads it for the planner and the executor's
 * storage lane: `none` when the battery is not observed or can only be
 * observed, else its setpoint surface and what PELS holds on it.
 */
export type BatteryLeverRead =
  | { kind: 'none' }
  | {
    kind: 'setpoint';
    /** The setpoint grid, W. */
    stepW: number;
    /** Resolved writable range, grid and exclusion band. */
    range: HomeBatterySetpointRange;
    /**
     * The most discharge PELS may ask for, W: the discharge range, or less
     * while an increase that plateaued short of it is the lesson
     * (`lib/battery/batteryVerification.ts`).
     */
    deliveryCeilingW: number;
    /**
     * The most charge PELS may ask for, W: the charge range, or less while a
     * charge that stopped short of it is the lesson.
     */
    chargeCeilingW: number;
    /** PELS holds a recorded claim and owes the battery a hand-back. */
    claimHeld: boolean;
    /**
     * A hand-back of this battery is running, waiting out its retry back-off, or
     * stopped for good: asking for another now would do nothing.
     */
    handBackDeferred: boolean;
    /** The battery reports Homey's claim value, so a setpoint written now steers it. */
    claimEngaged: boolean;
    /**
     * PELS may hold the battery: `admitClaim` would admit it now, Main's write
     * fence aside (a fence holds writes for a moment; it is no reason to hand the
     * battery back). Side-effect free: nothing is recorded.
     */
    admissible: boolean;
    verdict: StorageVerdict;
  };

/**
 * What a followed setpoint showed: the battery's own signed power then
 * (negative discharging, positive charging), and the tolerance it was judged
 * within, W.
 */
export type BatteryDelivery = { signedW: number; toleranceW: number };

/**
 * What the executor's storage lane learns from each setpoint, written to the
 * owner (`lib/battery/batteryVerification.ts`) and read back through
 * `readControl` by the planner input.
 */
export type BatteryVerificationRecorder = {
  /**
   * The battery followed a setpoint. A learned ceiling, discharge or charge, is
   * lifted only by a delivery past it by more than the tolerance.
   */
  recordResponding(deviceId: string, delivery: BatteryDelivery, nowMs: number): void;
  /** An increase in discharge plateaued short of its setpoint, at this discharge, W. */
  recordDeliveryCeiling(deviceId: string, dischargeW: number, nowMs: number): void;
  /**
   * An increase in charge stopped short of its setpoint, at this charge, W. It
   * teaches the charge ceiling and says nothing about whether the battery
   * follows: a full battery stops charging every sunny afternoon.
   */
  recordChargeCeiling(deviceId: string, chargeW: number, nowMs: number): void;
  /**
   * Whether this discharge, W, is within the tolerance of the last plateau the
   * battery showed this run, held or expired: a re-probe that starts there and
   * gets no further plateaued again rather than ignored the setpoint.
   */
  startsAtPlateau(deviceId: string, dischargeW: number, toleranceW: number): boolean;
  /** The battery's own power did not move within the confirmation window. */
  recordNotResponding(deviceId: string, nowMs: number): void;
  /** The battery's reported power moved opposite to the whole-home meter across several steps. */
  recordSignInverted(deviceId: string): void;
};

/** Whether `releaseClaim` handed the battery back. */
export type BatteryHandBackOutcome = 'released' | 'not_released';

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
  /** Serialize admission and the complete setpoint write with this battery's hand-backs. */
  dispatchSetpoint(deviceId: string, write: () => Promise<number | 'skipped'>): Promise<BatterySetpointOutcome>;
  /** The battery's lever as of now. */
  readControl(deviceId: string): BatteryLeverRead;
  /**
   * Hand the battery back because the plan released it. Joins a hand-back
   * already running, and honours one waiting out its back-off or stopped for
   * good (`not_released`); a failed one is retried by the owner like any other.
   */
  releaseClaim(deviceId: string, reason: StorageReleaseReason): Promise<BatteryHandBackOutcome>;
  /** Where the executor's storage lane records what each setpoint did. */
  readonly verification: BatteryVerificationRecorder;
  /**
   * A committed device snapshot: prunes the record of a battery gone from
   * Homey, and retries every hand-back that is due (boot recovery and failed
   * releases, with backoff).
   */
  onSnapshotCommitted(refresh: ObservedDeviceStateRefreshPayload): void;
  /** Re-read the owner's opt-out and hand back every claimed battery it now turns off. */
  applyControlSettings(): void;
};

/**
 * A home's binding to home-battery control: Main's battery control owner, or
 * `none` for a meter area, which projects no storage lever
 * (`lib/planInput/storageProjection.ts`) and builds no storage lane
 * (`lib/executor/batteryExecutor.ts`).
 */
export type StorageLaneBinding =
  | { kind: 'battery_control'; owner: BatteryControlOwner }
  | { kind: 'none' };
