/**
 * What a battery's claim shows against PELS's record of it, and whether a
 * hand-back of the record could succeed: the reads the battery control owner
 * (`batteryControlOwner.ts`, whose header says what each answer means) decides
 * admission, takeovers and hand-backs on, and the log of PELS's own claim
 * writes they are read against.
 */
import type { HomeBatteryClaimCapabilityId, HomeBatteryClaimObservation } from '../../packages/contracts/src/types';
import type {
  BatteryClaimAdmission, BatteryClaimRefusal, BatteryControlRead, BatteryLeverRead, BatteryLeverResponse,
} from '../ports/batteryControlOwner';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../ports/controlCommandConfirmation';
import type { AppActionControlTarget, StorageReleaseCommand, StorageControlBinding } from '../ports/storageCommand';
import type { BatteryClaimRecord } from './batteryClaimStore';
import { isPelsClaimValue, meterModeFor } from '../ports/homeBatteryResponse';

/** Complete write authority after durable claim admission. */
export type WriteAdmission = { status: 'admitted'; control: StorageControlBinding }
  | Extract<BatteryClaimAdmission, { status: 'refused' }>;

export type SetpointBatteryRead = Extract<BatteryControlRead, { kind: 'setpoint' }>;

type BatteryLeverGridCharge = Extract<BatteryLeverRead, { kind: 'setpoint' }>['gridCharge'];

type BatteryLeverOwnModeGridCharge = Extract<BatteryLeverRead, { kind: 'setpoint' }>['ownModeGridCharge'];

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
  battery.kind === 'app_actions' || battery.kind === 'hand_back_only' || battery.kind === 'homey_api_key_missing'
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
  | { kind: 'app_actions'; target: AppActionControlTarget };

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

/**
 * How long a meter-following battery's hand-back waits for the battery to
 * report the restored mode. Its app may drop a mode change made too soon after
 * the last and still answer success (`notes/battery-vendor-bindings.md`), so
 * only the report confirms it. A battery reports only a change: once the
 * window has passed, its last report is its mode, and a restore to the mode it
 * already held shows as landed then.
 */
export const HAND_BACK_REPORT_WINDOW_MS = 15_000;

/** Whether the battery confirms a hand-back only by reporting the restored mode. */
export const awaitsHandBackReport = (battery: BatteryControlRead): battery is SetpointBatteryRead => (
  battery.kind === 'setpoint' && battery.surface.response.kind === 'follows_meter'
);

/**
 * Whether the battery reports a claim value PELS drives it with: Homey's
 * claim value, or for a meter-following battery one of its command modes.
 * Under a claim, PELS's or anyone's.
 */
export const isClaimEngaged = (battery: SetpointBatteryRead): boolean => (
  !('kind' in battery.claim) && isPelsClaimValue(battery.surface.response, battery.claim.value)
);

/**
 * Whether a meter-following battery reports the mode a setpoint maps to
 * (`meterModeFor`): the evidence that command landed. A battery that delivers
 * its setpoint answers with its own power instead, and is never judged here.
 */
export const reportsMeterMode = (battery: SetpointBatteryRead, setpointW: number): boolean => {
  const { response } = battery.surface;
  return response.kind === 'follows_meter' && !('kind' in battery.claim)
    && battery.claim.value === meterModeFor(response.modes, setpointW);
};

/** How the storage lane judges this battery's setpoints (`BatteryLeverResponse`). */
export const toLeverResponse = (battery: DrivableBatteryRead): BatteryLeverResponse => (
  battery.kind === 'setpoint' && battery.surface.response.kind === 'follows_meter'
    ? { kind: 'follows_meter', reportsSetpoint: (setpointW) => reportsMeterMode(battery, setpointW) }
    : { kind: 'delivers_setpoint' }
);

/** How the battery plan may charge it from the grid: only at a meter-following battery's grid-charge power. */
export const toGridCharge = (battery: DrivableBatteryRead): BatteryLeverGridCharge => (
  battery.kind === 'setpoint' && battery.surface.response.kind === 'follows_meter'
    ? { kind: 'fixed', powerW: battery.surface.response.modes.gridChargeW }
    : { kind: 'any' }
);

/**
 * What the battery's own mode takes from the grid once handed back: a
 * meter-following battery's declared by the mode it returns to (its record's,
 * else the mode it reports now), any other battery's judged from its power.
 */
export const toOwnModeGridCharge = (
  battery: DrivableBatteryRead, record: BatteryClaimRecord | undefined,
): BatteryLeverOwnModeGridCharge => {
  if (battery.kind !== 'setpoint' || battery.surface.response.kind !== 'follows_meter') return { kind: 'observed' };
  const { modes } = battery.surface.response;
  const reported = 'kind' in battery.claim ? undefined : battery.claim.value;
  const ownMode = record?.kind === 'claim_capability' ? record.previousValue : reported;
  const chargesFromGrid = ownMode !== undefined && modes.gridChargingModes.includes(ownMode);
  return { kind: 'declared', chargeW: chargesFromGrid ? modes.gridChargeW : 0 };
};

/** The lever's two grid-charge facts: how the plan may grid-charge it, and what its own mode would. */
export const toGridChargeFacts = (
  battery: DrivableBatteryRead, record: BatteryClaimRecord | undefined,
): { gridCharge: BatteryLeverGridCharge; ownModeGridCharge: BatteryLeverOwnModeGridCharge } => ({
  gridCharge: toGridCharge(battery), ownModeGridCharge: toOwnModeGridCharge(battery, record),
});

/**
 * What to record before PELS first claims a battery: the claim value it
 * reports now, provided PELS could hand the battery back to it. A claim-less
 * battery has nothing to restore.
 */
export const resolveValueToRecord = (
  battery: DrivableBatteryRead,
): BatteryClaimRefusal | ClaimToRecord => {
  if (battery.kind === 'app_actions') return { kind: 'app_actions', target: battery.target };
  const { surface, claim } = battery;
  if ('kind' in claim) return 'claim_unobserved';
  // A meter-following battery's own modes include PELS's: one an owner left it
  // in (standby) is still a mode to hand back to, never someone else's claim.
  if (surface.response.kind === 'delivers_setpoint' && claim.value === surface.response.claimValue) {
    return 'held_by_other';
  }
  if (!surface.claim.values.includes(claim.value)) return 'claim_value_undeclared';
  return { kind: 'claim_capability', claim, capabilityId: surface.claim.capabilityId };
};

/** The record of a claim admitted at `claimedAtMs`. */
export const toClaimRecord = (
  value: ClaimToRecord, claimedAtMs: number,
): Exclude<BatteryClaimRecord, { kind: 'legacy_app_actions' }> => (
  value.kind === 'app_actions'
    ? { kind: 'app_actions', target: value.target, claimedAtMs }
    : { kind: 'claim_capability', capabilityId: value.capabilityId, previousValue: value.claim.value, claimedAtMs }
);

/** Whether the record describes the binding the battery has now: the same claim capability, or app actions. */
export const isRecordOfBinding = (record: BatteryClaimRecord, battery: DrivableBatteryRead): boolean => (
  battery.kind === 'app_actions'
    ? record.kind === 'app_actions' && record.target.appUri === battery.target.appUri
      && record.target.deviceId === battery.target.deviceId
    : record.kind === 'claim_capability' && record.capabilityId === battery.surface.claim.capabilityId
);

/** Why no hand-back could ever succeed against the battery as it is now; `undefined` when one could. */
export const resolveTerminalFailure = (
  record: BatteryClaimRecord,
  battery: Exclude<BatteryControlRead, { kind: 'unobserved' }>,
): TerminalReleaseFailure | undefined => {
  // Its command actions are gone, its hand-back actions are not.
  if (battery.kind === 'hand_back_only') return record.kind !== 'claim_capability' ? undefined : 'capability_mismatch';
  if (battery.kind === 'app_actions' && record.kind !== 'claim_capability') return undefined;
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
   * restore. A meter-following battery reporting that value once the report
   * window after the restore has passed shows it too
   * (`HAND_BACK_REPORT_WINDOW_MS`).
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
    if (restoredAtMs !== undefined) {
      return claim.observedAtMs > restoredAtMs
        || (awaitsHandBackReport(battery) && nowMs - restoredAtMs >= HAND_BACK_REPORT_WINDOW_MS);
    }
    return bootRecovery && this.readStanding(deviceId, record, battery, nowMs) !== 'held';
  }

  /**
   * Whether a hand-back just written to this battery waits for its report:
   * a meter-following battery that does not show the restored mode yet
   * (`HAND_BACK_REPORT_WINDOW_MS`). Every other battery's write is its
   * hand-back.
   */
  owesHandBackReport(
    deviceId: string, record: BatteryClaimRecord, battery: BatteryControlRead, nowMs: number,
  ): boolean {
    return awaitsHandBackReport(battery) && !this.showsLandedHandBack(deviceId, record, battery, false, nowMs);
  }

  /**
   * What a hand-back of this record would do to the battery as it is now:
   * nothing it could ever do (`terminal`), nothing because PELS's own earlier
   * hand-back already landed (`handed_back`), wait because the battery's claim
   * is contested (`contested`), nothing because someone else took the battery
   * over (`superseded`), or the hand-back.
   */
  classifyRelease(
    deviceId: string,
    record: BatteryClaimRecord,
    battery: Exclude<BatteryControlRead, { kind: 'unobserved' }>,
    bootRecovery: boolean,
    nowMs: number,
  ): ReleaseVerdict {
    const failure = resolveTerminalFailure(record, battery);
    if (failure !== undefined) return { kind: 'terminal', failure };
    // A claim-less battery shows neither a landed hand-back nor a takeover.
    if (battery.kind !== 'setpoint') return { kind: 'release' };
    if (this.showsLandedHandBack(deviceId, record, battery, bootRecovery, nowMs)) return { kind: 'handed_back' };
    const standing = this.readStanding(deviceId, record, battery, nowMs);
    if (standing === 'held') return { kind: 'release' };
    return standing === 'contested' ? { kind: 'contested' } : { kind: 'superseded' };
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
    if (isPelsClaimValue(surface.response, claim.value) || claim.observedAtMs <= lastWriteMs) return 'held';
    return nowMs - lastWriteMs < CONTROL_COMMAND_CONFIRMATION_MS ? 'contested' : 'taken_over';
  }
}

export const toReleaseCommand = (deviceId: string, record: BatteryClaimRecord): StorageReleaseCommand => {
  if (record.kind === 'claim_capability') {
    return { kind: 'storage_release', deviceId, handBack: 'claim_capability', restoreClaimValue: record.previousValue };
  }
  if (record.kind === 'legacy_app_actions') {
    return { kind: 'storage_release', deviceId, handBack: 'legacy_app_actions' };
  }
  return { kind: 'storage_release', deviceId, handBack: 'app_actions', target: record.target };
};

/** The write authority of an accepted current-schema claim. */
export const toControlBinding = (
  record: Exclude<BatteryClaimRecord, { kind: 'legacy_app_actions' }>,
): StorageControlBinding => (
  record.kind === 'app_actions' ? { kind: 'app_actions', target: record.target } : { kind: 'capability' }
);
