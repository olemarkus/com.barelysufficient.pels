/**
 * The Main home's home-battery control owner (port:
 * `lib/ports/batteryControlOwner.ts`): claim admission, the durable claim
 * record, the hand-back, and what each battery has shown about following a
 * setpoint (`batteryVerification.ts`). It issues no setpoint: the executor's
 * storage lane issues `storage_power` through Main's fenced plan actuator, and
 * only through `dispatchSetpoint`, which serializes admission and the complete
 * write with hand-back. `readControl` is the planner input's read of all of it.
 *
 * - **Admission.** A claim is admitted only for a `setpoint` battery (as the
 *   device transport reads it, `readBatteryControl`) the owner has not opted
 *   out, that is a Main-home member on settled membership, while Main may
 *   write (not fenced, not in capacity simulation). Before the first
 *   admission the owner records the claim value the battery holds
 *   (`batteryClaimStore.ts`).
 * - **Hand-back.** When the plan releases the battery (`releaseClaim`: idle,
 *   meter silent, no longer admissible, not responding, inverted sign), on
 *   opt-out, in capacity simulation, and at the first boot that finds a record
 *   left by a run that never handed back. Boot recovery from the durable claim
 *   record is THE hand-back after an app stop, a crash or a restart alike:
 *   there is none at app stop, because Homey ends the app some 15-20 ms after
 *   "Stopping...", before a capability write could complete. Hand-back is
 *   exempt from Main's fence and from capacity simulation, like the executor's
 *   lifecycle release (`lib/executor/binaryExecutor.ts`, `turnOffDevice`): it
 *   returns the battery to the state the owner chose before PELS took it, which
 *   is never the control action a fence or a simulation exists to hold back.
 * - **Takeover.** A battery observed under another claim value is handed
 *   back anyway unless that observation is dated after PELS's last claim
 *   write: a snapshot older than the write still shows the pre-claim value.
 *   A newer one is contested for `CONTROL_COMMAND_CONFIRMATION_MS` after the
 *   write, because a battery app that read its own mode early in a poll
 *   writes that mode back at the end (the Marstek and Sessy apps both do), so
 *   the next report is PELS's claim again. While contested PELS writes no
 *   claim and does not hand back; a report of Homey's value ends it. Another
 *   value still shown once the window is over is a takeover: PELS turns the
 *   battery's Managed off. A battery that shows the value PELS would restore
 *   after a restore PELS issued this run (or, at boot recovery, after its
 *   claim) was handed back by PELS, not taken over: a hand-back write can
 *   land and still report failure, and a record whose delete failed outlives
 *   the hand-back it recorded. The record is dropped and Managed stays as it
 *   is. Without a hand-back behind it the same report proves nothing: on a
 *   first claim the stale echo is the value PELS would restore.
 * - **Retries.** A failed hand-back is retried on committed snapshots with a
 *   per-battery backoff. A terminal one (a restore value or claim capability
 *   the battery no longer declares, a battery PELS can only observe, or a
 *   device that is no battery any more) is logged once and keeps its record
 *   without retrying until a committed snapshot shows the battery's control
 *   surface changed what stopped it. A battery PELS only watches is not
 *   handed back while it lasts (its app refuses the writes as well), and
 *   nothing is recorded for the attempt: the hand-back is due again as soon
 *   as watch-only ends.
 * - **Watch only.** A claim write the battery's app rejected, on a binding
 *   whose rejection means the app refuses control as it is set up
 *   (`app_refuses_control`: a Sessy on its cloud login), to a battery that
 *   does not show Homey's claim value, leaves the battery
 *   one PELS can only watch until the app restarts, its control surface
 *   changes, or `BATTERY_WATCH_ONLY_MS` has passed: no claim is admitted and
 *   `readControl` reads no lever, so the plan neither limits it nor stores
 *   solar in it. It stays Managed. A single rejection is not proof enough to
 *   lose control for good: a local-login Sessy whose dongle call failed once
 *   rejects the claim too. When the time is up the next claim decides again,
 *   so a cloud-login Sessy costs one rejected write per period. The
 *   rejected write changed nothing, so a record this same dispatch made is
 *   dropped: there is nothing to hand back. A record made before it is kept,
 *   with the restore value it names. A battery that shows Homey's claim gets
 *   no claim write at all (the transport writes the claim only to one that
 *   does not); one that came to show it while a rejected write was out (one
 *   PELS is driving, or a record a previous run left) is never left
 *   watch-only: a cloud-login Sessy never shows it, so the rejection is a
 *   failed write, and the storage lane judges it like an unanswered setpoint,
 *   so the plan hands the battery back. Any other binding's rejected claim is
 *   judged that way too.
 *
 * A leaf domain: it imports only `lib/ports`, `lib/utils`, `lib/logging` and
 * the shared packages.
 */
import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';
import type { HomeBatteryClaimObservation, HomeBatteryControlCapability } from '../../packages/contracts/src/types';
import { getLogger } from '../logging/logger';
import { AbsentBatteries } from './absentBatteries';
import type {
  BatteryClaimAdmission,
  BatteryClaimRefusal,
  BatteryControlOwner,
  BatteryControlRead,
  BatteryHandBackOutcome,
  BatteryLeverRead,
  BatterySetpointOutcome,
  BatterySetpointWrite,
  StorageReleaseReason,
} from '../ports/batteryControlOwner';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { StorageActuation, StorageClaimRejected } from '../ports/storageCommand';
import { normalizeError } from '../utils/errorUtils';
import { BATTERY_CONTROL_DEVICES } from '../utils/settingsKeys';
import { BatteryClaimStore, type BatteryClaimRecord } from './batteryClaimStore';
import {
  ClaimWriteLog,
  isClaimEngaged,
  resolveTerminalFailure,
  resolveValueToRecord,
  type ReleaseVerdict,
  type SetpointBatteryRead,
  type TerminalReleaseFailure,
} from './batteryClaimStanding';
import { isBatteryControlEnabled } from '../../packages/shared-domain/src/settings/batteryControlDevices';
import type { BatteryManagedSettings } from './batteryControlSettings';
import { PendingHandBacks, type ReleaseReason } from './pendingHandBacks';
import { BatteryVerificationLedger } from './batteryVerification';
import { BATTERY_WATCH_ONLY_MS, BatteryWatchOnlyLedger } from './batteryWatchOnly';

const logger = getLogger('battery');

/**
 * Whether an admission check holds the moments that only hold a write back
 * (Main's write fence, a contested claim) against the battery. Neither is a
 * reason to hand the battery back, so the lever read ignores them.
 */
type MomentaryHolds = 'holds_apply' | 'holds_ignored';

type LoadedClaimRecords = {
  status: 'loaded';
  records: Map<string, BatteryClaimRecord>;
  unreadable: ReadonlySet<string>;
};

/** The stored claim records, or that their key list has not read cleanly yet. */
type ClaimRecords = LoadedClaimRecords | { status: 'unavailable' };

/**
 * An admission check that passed, writing nothing: the battery's record is
 * stored (`recorded`), or the claim value it reports now can be recorded
 * before the first claim (`recordable`).
 */
type RecordableClaim = {
  kind: 'recordable';
  claims: LoadedClaimRecords;
  battery: SetpointBatteryRead;
  value: HomeBatteryClaimObservation;
};
type ClaimCheck = { kind: 'recorded' } | RecordableClaim;

export class HomeBatteryControlOwner implements BatteryControlOwner {
  private readonly store: BatteryClaimStore;
  /** The stored claim records; read from the store until a read resolves. */
  private claims: ClaimRecords = { status: 'unavailable' };
  /** Records still owed a hand-back that is not running right now. */
  private readonly pending = new PendingHandBacks();
  /** Complete refreshes in a row each recorded battery has been missing from. */
  private readonly absent = new AbsentBatteries();
  /** Hand-backs running now, each answering whether the battery went back. */
  private readonly releasing = new Map<string, Promise<boolean>>();
  /** Batteries whose Managed PELS turned off this run because the owner took them over. */
  private readonly takenOver = new Set<string>();
  /** Batteries whose app refused control, for now (`batteryWatchOnly.ts`). */
  private readonly watchOnly = new BatteryWatchOnlyLedger();
  private readonly writes = new Map<string, Promise<void>>();
  /** PELS's own claim writes, which a battery's claim standing is read against. */
  private readonly claimWrites = new ClaimWriteLog();
  readonly verification = new BatteryVerificationLedger();

  /**
   * @param settings The settings store the claim records live in, and the
   *   Managed map is written to.
   * @param managed The owner's Managed map; `isManaged` and admission answer from it.
   * @param actuation The write seam. The owner dispatches only hand-backs through it.
   * @param getBattery The device as the transport resolves it (`readBatteryControl`).
   * @param isMainHomeMember Whether the device's Main-home membership is settled;
   *   false while membership is unknown or an ownership change is pending.
   * @param isActuationFenced Main's write fence: a home torn down, ownership
   *   unsettled, or a superseded apply.
   * @param isCapacityDryRun Capacity simulation (dry run): nothing may be written.
   */
  constructor(
    private readonly settings: SettingsPort,
    private readonly managed: BatteryManagedSettings,
    private readonly actuation: StorageActuation,
    private readonly getBattery: (deviceId: string) => BatteryControlRead,
    private readonly isMainHomeMember: (deviceId: string) => boolean,
    private readonly isActuationFenced: () => boolean,
    private readonly isCapacityDryRun: () => boolean,
  ) {
    this.store = new BatteryClaimStore(settings);
    // Settle the map the owner starts from, so the first change to it is told
    // apart from it (`applyControlSettings`).
    managed.read();
  }

  admitClaim(deviceId: string): BatteryClaimAdmission {
    this.settleObservedHandBack(deviceId);
    const check = this.checkClaim(deviceId, 'holds_apply');
    if (check === 'claim_lost') {
      this.disableAfterTakeover(deviceId);
      return { status: 'refused', reason: 'control_disabled' };
    }
    if (typeof check === 'string') return { status: 'refused', reason: check };
    if (check.kind === 'recorded') {
      // A record a previous run left is adopted rather than handed back: it
      // still names the value the battery held before PELS first claimed it.
      this.pending.delete(deviceId);
      return { status: 'admitted' };
    }
    const refusal = this.recordClaim(deviceId, check);
    return refusal === 'admitted' ? { status: 'admitted' } : { status: 'refused', reason: refusal };
  }

  dispatchSetpoint(deviceId: string, write: () => Promise<BatterySetpointWrite>): Promise<BatterySetpointOutcome> {
    return this.serializeWrite(deviceId, async () => {
      const recordBefore = this.readRecord(deviceId);
      const admission = this.admitClaim(deviceId);
      if (admission.status === 'refused') return admission;
      // The transport writes the claim before the setpoint only to a battery
      // that does not report Homey's value (`requestStoragePower`).
      const battery = this.getBattery(deviceId);
      if (battery.kind === 'setpoint' && !isClaimEngaged(battery)) this.claimWrites.noteWrite(deviceId, Date.now());
      const written = await write();
      if (typeof written === 'object') {
        return this.judgeClaimRejected(deviceId, written, recordBefore === undefined ? 'recorded_now' : 'kept');
      }
      return { status: 'dispatched', setpointW: written };
    });
  }

  wasTakenOver(deviceId: string): boolean {
    return this.takenOver.has(deviceId);
  }

  isWatchOnly(deviceId: string): boolean {
    const battery = this.getBattery(deviceId);
    const surface = battery.kind === 'setpoint' ? battery.surface : battery.kind;
    return this.watchOnly.isWatchOnly(deviceId, surface, Date.now());
  }

  readControlCapability(deviceId: string): HomeBatteryControlCapability | 'not_battery' {
    const battery = this.getBattery(deviceId);
    if (battery.kind === 'not_battery') return 'not_battery';
    if (battery.kind !== 'setpoint') return 'observe_only';
    return this.watchOnly.isWatchOnly(deviceId, battery.surface, Date.now()) ? 'watch_only' : 'drivable';
  }

  /**
   * The battery's app rejected the claim write, so no setpoint went out. On a
   * binding whose rejection means the app refuses control, PELS only watches
   * the battery from now on (see the header); on any other, the storage lane
   * judges the setpoint unanswered.
   */
  private judgeClaimRejected(
    deviceId: string,
    rejected: StorageClaimRejected,
    record: 'recorded_now' | 'kept',
  ): BatterySetpointOutcome {
    const { errorMessage } = rejected;
    const battery = this.getBattery(deviceId);
    // A battery under Homey's claim may be one PELS is driving: leaving it
    // watch-only would strand it at its last setpoint with no hand-back.
    if (
      battery.kind !== 'setpoint'
      || battery.surface.claim.rejection !== 'app_refuses_control'
      || isClaimEngaged(battery)
    ) {
      return { status: 'claim_rejected', effect: 'unanswered', errorMessage };
    }
    this.watchOnly.begin(deviceId, battery.surface, Date.now());
    const claims = this.loadClaims();
    // The record this dispatch made names a claim the rejected write never
    // took: nothing to hand back. One made before keeps its restore value.
    const recordRemoved = record === 'recorded_now' && claims.status === 'loaded'
      && claims.records.has(deviceId) && this.forget(claims, deviceId);
    logger.warn({
      event: 'battery_control_claim_rejected_watch_only',
      deviceId,
      claimCapabilityId: battery.surface.claim.capabilityId,
      errorMessage,
      recordRemoved,
      watchOnlyMs: BATTERY_WATCH_ONLY_MS,
      msg: 'The battery app rejected control; PELS only watches the battery for 6 h, or until it restarts',
    });
    return { status: 'claim_rejected', effect: 'watch_only', errorMessage };
  }

  isManaged(deviceId: string): boolean {
    return this.managed.isManaged(deviceId);
  }

  /** Store the owner's Managed choice for this battery, then apply it as any settings change is applied. */
  setControlEnabled(deviceId: string, enabled: boolean): void {
    const control = this.managed.reload();
    if (control.status !== 'resolved') throw new Error('Battery control settings could not be read. Try again.');
    this.settings.set(BATTERY_CONTROL_DEVICES, { ...control.devices, [deviceId]: enabled });
    this.applyControlSettings();
  }

  /**
   * Turn Managed off for a battery someone else took over. An owner's re-enable
   * that is stored but not applied yet (its settings event is still on its way)
   * overrules the takeover: it is applied, which adopts the battery's new mode,
   * rather than overwritten with off.
   */
  private disableAfterTakeover(deviceId: string): boolean {
    if (this.hasUnappliedReenable(deviceId)) {
      this.applyControlSettings();
      return true;
    }
    // Turning Managed off applies at once, and its opted-out hand-back finds the
    // same takeover in the same turn: that one is already recorded and logged.
    if (this.takenOver.has(deviceId) && !this.isManaged(deviceId)) return true;
    this.takenOver.add(deviceId);
    try {
      this.setControlEnabled(deviceId, false);
      logger.info({ event: 'battery_control_claim_lost', deviceId });
      return true;
    } catch (error) {
      this.takenOver.delete(deviceId);
      logger.warn({ event: 'battery_control_opt_out_failed', deviceId, err: normalizeError(error) });
      return false;
    }
  }

  private hasUnappliedReenable(deviceId: string): boolean {
    const held = this.managed.read();
    const stored = this.managed.readStored();
    return held.status === 'resolved' && stored.status === 'resolved'
      && !isBatteryControlEnabled(held.devices, deviceId) && isBatteryControlEnabled(stored.devices, deviceId);
  }

  private serializeWrite<T>(deviceId: string, write: () => Promise<T>): Promise<T> {
    const work = (this.writes.get(deviceId) ?? Promise.resolve()).then(write);
    const settled = work.then(() => undefined, () => undefined);
    this.writes.set(deviceId, settled);
    void settled.then(() => { if (this.writes.get(deviceId) === settled) this.writes.delete(deviceId); });
    return work;
  }

  readControl(deviceId: string): BatteryLeverRead {
    const battery = this.getBattery(deviceId);
    // A watch-only battery is still read, so its discharge counts against
    // surplus devices; `checkClaim` answers `watch_only`, so it is never
    // admissible and never claimed, limited or offered surplus.
    if (battery.kind !== 'setpoint') return { kind: 'none' };
    const { surface } = battery;
    const nowMs = Date.now();
    const claims = this.loadClaims();
    const verification = this.verification.read(deviceId, surface.range, nowMs);
    const record = claims.status === 'loaded' ? claims.records.get(deviceId) : undefined;
    return {
      kind: 'setpoint',
      stepW: surface.range.stepW,
      range: surface.range,
      deliveryCeilingW: verification.deliveryCeilingW,
      chargeCeilingW: verification.chargeCeilingW,
      claimHeld: claims.status === 'loaded' && claims.records.has(deviceId),
      handBackDeferred: this.releasing.has(deviceId) || this.pending.isWaiting(deviceId, nowMs)
        || (record !== undefined && this.claimWrites.readStanding(deviceId, record, battery, nowMs) === 'taken_over'),
      claimEngaged: isClaimEngaged(battery),
      // Main's write fence is a moment (a superseded apply, a teardown), not a
      // reason to hand the battery back: the fenced actuator already holds
      // every write while it lasts. A contested claim is one too: it ends at
      // the battery's next report or with the confirmation window.
      admissible: typeof this.checkClaim(deviceId, 'holds_ignored') !== 'string',
      verdict: verification.verdict,
    };
  }

  async releaseClaim(deviceId: string, reason: StorageReleaseReason): Promise<BatteryHandBackOutcome> {
    if (this.pending.isWaiting(deviceId, Date.now())) return 'not_released';
    return (await this.release(deviceId, reason)) ? 'released' : 'not_released';
  }

  onSnapshotCommitted(refresh: ObservedDeviceStateRefreshPayload): void {
    const claims = this.loadClaims();
    if (claims.status !== 'loaded') return;
    this.retryUnreadableClaims(claims);
    this.pruneRemovedBatteries(claims, refresh);
    this.disableTakenOverClaims(claims);
    // Capacity simulation writes nothing, so no plan apply would ever carry the
    // planner's hand-back of a battery claimed before it was switched on.
    // Hand-back is exempt from simulation; the owner does it here.
    if (this.isCapacityDryRun()) {
      for (const deviceId of claims.records.keys()) {
        if (!this.pending.has(deviceId) && !this.releasing.has(deviceId)) void this.release(deviceId, 'not_admissible');
      }
    }
    this.retryPendingHandBacks(claims, Date.now());
  }

  /** Retry each hand-back that is due, and each terminal one the battery's control surface lifted. */
  private retryPendingHandBacks(claims: LoadedClaimRecords, nowMs: number): void {
    for (const [deviceId, pending] of this.pending) {
      if (this.releasing.has(deviceId)) continue;
      const retry = pending.state === 'terminal'
        ? this.isTerminalFailureLifted(claims, deviceId, pending.failure)
        // An unseen battery has no binding to write through yet.
        : pending.nextAttemptAtMs <= nowMs && this.getBattery(deviceId).kind !== 'unobserved';
      if (retry) void this.release(deviceId, pending.reason);
    }
  }

  /**
   * Whether the battery's control surface no longer stops its hand-back for
   * the reason it stopped: the next attempt decides again.
   */
  private isTerminalFailureLifted(
    claims: LoadedClaimRecords,
    deviceId: string,
    failure: TerminalReleaseFailure,
  ): boolean {
    const record = claims.records.get(deviceId);
    const battery = this.getBattery(deviceId);
    if (record === undefined || battery.kind === 'unobserved') return false;
    return resolveTerminalFailure(record, battery) !== failure;
  }

  private disableTakenOverClaims(claims: LoadedClaimRecords): void {
    const nowMs = Date.now();
    for (const [deviceId, record] of claims.records) {
      if (this.releasing.has(deviceId) || this.settleObservedHandBack(deviceId)) continue;
      const battery = this.getBattery(deviceId);
      if (battery.kind !== 'setpoint') continue;
      const standing = this.claimWrites.readStanding(deviceId, record, battery, nowMs);
      if (standing === 'taken_over') this.disableAfterTakeover(deviceId);
    }
  }

  /** Whether PELS's own hand-back of this battery landed (`ClaimWriteLog.showsLandedHandBack`): never a takeover. */
  private showsOwedHandBack(deviceId: string, record: BatteryClaimRecord, battery: SetpointBatteryRead): boolean {
    const bootRecovery = this.pending.get(deviceId)?.reason === 'boot_recovery';
    return this.claimWrites.showsLandedHandBack(deviceId, record, battery, bootRecovery, Date.now());
  }

  /**
   * Drop the record of a battery that shows its owed hand-back
   * (`showsOwedHandBack`), logged as released. True when it did.
   */
  private settleObservedHandBack(deviceId: string): boolean {
    const claims = this.loadClaims();
    if (claims.status !== 'loaded' || this.releasing.has(deviceId)) return false;
    const record = claims.records.get(deviceId);
    const pending = this.pending.get(deviceId);
    const battery = this.getBattery(deviceId);
    if (record === undefined || pending === undefined || battery.kind !== 'setpoint') return false;
    if (!this.showsOwedHandBack(deviceId, record, battery)) return false;
    this.forgetHandedBack(claims, deviceId, record, pending.reason);
    return true;
  }

  private forgetHandedBack(
    claims: LoadedClaimRecords,
    deviceId: string,
    record: BatteryClaimRecord,
    reason: ReleaseReason,
  ): void {
    const recordRemoved = this.forget(claims, deviceId);
    logger.info({
      event: 'battery_control_released',
      deviceId,
      reason,
      restoredClaimValue: record.previousValue,
      recordRemoved,
      evidence: 'battery_reports_restore_value',
    });
  }

  applyControlSettings(): void {
    // A failed read keeps the last map that read cleanly (`BatteryManagedSettings`),
    // so a battery PELS holds stays managed, and stays in the plan, through it.
    const previous = this.managed.read();
    const control = this.managed.reload();
    if (control.status !== 'resolved') return;
    const { devices } = control;
    for (const deviceId of [...this.takenOver]) {
      if (isBatteryControlEnabled(devices, deviceId)) this.takenOver.delete(deviceId);
    }
    const claims = this.loadClaims();
    if (claims.status !== 'loaded') return;
    for (const deviceId of [...claims.records.keys()]) {
      if (!isBatteryControlEnabled(devices, deviceId)) {
        void this.release(deviceId, 'opted_out');
      } else if (previous.status === 'resolved' && !isBatteryControlEnabled(previous.devices, deviceId)) {
        this.adoptAfterReenable(claims, deviceId);
      }
    }
  }

  /**
   * The owner turned Managed back on. A record still naming a takeover is the
   * one the owner just overruled: it would otherwise read as the takeover again
   * and turn Managed straight back off. Dropping it lets the next claim record
   * the mode the battery runs now, which is the one PELS hands back to.
   */
  private adoptAfterReenable(claims: LoadedClaimRecords, deviceId: string): void {
    const record = claims.records.get(deviceId);
    const battery = this.getBattery(deviceId);
    if (record === undefined || battery.kind !== 'setpoint') return;
    if (this.claimWrites.readStanding(deviceId, record, battery, Date.now()) === 'held') return;
    const recordRemoved = this.forget(claims, deviceId);
    if (!recordRemoved) {
      // The record stays stored and would read as the takeover again at the
      // next boot, turning Managed straight back off.
      logger.warn({ event: 'battery_control_takeover_record_remove_failed', deviceId });
      return;
    }
    logger.info({ event: 'battery_control_reenabled_after_takeover', deviceId });
  }

  /** Every admission check, writing nothing. */
  private checkClaim(deviceId: string, holds: MomentaryHolds): BatteryClaimRefusal | ClaimCheck {
    const battery = this.getBattery(deviceId);
    if (battery.kind !== 'setpoint') return 'not_drivable';
    if (this.isWatchOnly(deviceId)) return 'watch_only';
    const control = this.managed.read();
    if (control.status !== 'resolved') return 'control_setting_unreadable';
    if (!isBatteryControlEnabled(control.devices, deviceId)) return 'control_disabled';
    if (!this.isMainHomeMember(deviceId)) return 'not_main_home';
    if (holds === 'holds_apply' && this.isActuationFenced()) return 'actuation_fenced';
    if (this.isCapacityDryRun()) return 'dry_run';
    if (this.releasing.has(deviceId) || this.pending.isWaiting(deviceId, Date.now())) return 'release_in_flight';
    const claims = this.loadClaims();
    if (claims.status !== 'loaded') return 'claim_records_unread';
    if (claims.unreadable.has(deviceId)) return 'claim_record_unreadable';
    const record = claims.records.get(deviceId);
    if (record !== undefined) {
      return this.checkRecordedClaim(deviceId, record, battery, holds);
    }
    const value = resolveValueToRecord(battery);
    return typeof value === 'string' ? value : { kind: 'recordable', claims, battery, value };
  }

  private checkRecordedClaim(
    deviceId: string,
    record: BatteryClaimRecord,
    battery: SetpointBatteryRead,
    holds: MomentaryHolds,
  ): BatteryClaimRefusal | ClaimCheck {
    if (record.capabilityId !== battery.surface.claim.capabilityId) return 'claim_record_mismatch';
    const standing = this.claimWrites.readStanding(deviceId, record, battery, Date.now());
    if (standing === 'taken_over') return 'claim_lost';
    return standing === 'contested' && holds === 'holds_apply' ? 'claim_contested' : { kind: 'recorded' };
  }

  /** Durably record what the battery holds now, before any claim write. */
  private recordClaim(deviceId: string, recordable: RecordableClaim): BatteryClaimRefusal | 'admitted' {
    const { claims, battery, value: observed } = recordable;
    const record: BatteryClaimRecord = {
      capabilityId: battery.surface.claim.capabilityId,
      previousValue: observed.value,
      claimedAtMs: Date.now(),
    };
    if (!this.store.write(deviceId, record)) {
      logger.warn({ event: 'battery_control_claim_record_failed', deviceId });
      return 'claim_record_unwritable';
    }
    claims.records.set(deviceId, record);
    logger.info({
      event: 'battery_control_claimed',
      deviceId,
      claimCapabilityId: record.capabilityId,
      previousClaimValue: record.previousValue,
    });
    return 'admitted';
  }

  /**
   * The claim records, read from the store until the read resolves. Every
   * record found then is a claim the previous run never handed back; a record
   * that does not parse is logged once and leaves every other battery alone.
   */
  private loadClaims(): ClaimRecords {
    if (this.claims.status === 'loaded') return this.claims;
    const read = this.store.readAll();
    if (read.status !== 'resolved') return this.claims;
    this.claims = {
      status: 'loaded',
      records: new Map(read.records),
      unreadable: new Set(read.unreadableDeviceIds),
    };
    for (const deviceId of read.records.keys()) {
      this.pending.markBootRecovery(deviceId);
    }
    for (const deviceId of read.unreadableDeviceIds) {
      logger.warn({ event: 'battery_control_claim_record_unreadable', deviceId });
    }
    return this.claims;
  }

  private retryUnreadableClaims(claims: LoadedClaimRecords): void {
    if (claims.unreadable.size === 0) return;
    const read = this.store.readAll();
    if (read.status !== 'resolved') return;
    const unreadable = new Set([...claims.unreadable].filter((id) => read.unreadableDeviceIds.includes(id)));
    for (const deviceId of claims.unreadable) {
      const record = read.records.get(deviceId);
      if (record === undefined) continue;
      claims.records.set(deviceId, record);
      this.pending.markBootRecovery(deviceId);
    }
    this.claims = { ...claims, unreadable };
  }

  /**
   * Drop the record of a battery missing from two complete refreshes in a row.
   * An empty refresh proves nothing about any one battery and counts for
   * nothing; a failed one never reaches here.
   */
  private pruneRemovedBatteries(claims: LoadedClaimRecords, refresh: ObservedDeviceStateRefreshPayload): void {
    for (const deviceId of this.absent.dueForPrune([...claims.records.keys()], refresh)) {
      if (this.releasing.has(deviceId)) continue;
      this.forget(claims, deviceId);
      logger.info({ event: 'battery_control_claim_pruned', deviceId, reason: 'device_removed' });
    }
  }

  /** The battery's stored claim record, or `undefined` when it has none or the records are not read. */
  private readRecord(deviceId: string): BatteryClaimRecord | undefined {
    const claims = this.loadClaims();
    return claims.status === 'loaded' ? claims.records.get(deviceId) : undefined;
  }

  private forget(claims: LoadedClaimRecords, deviceId: string): boolean {
    claims.records.delete(deviceId);
    this.claimWrites.forget(deviceId);
    this.pending.delete(deviceId);
    this.absent.forget(deviceId);
    return this.store.remove(deviceId);
  }

  /**
   * Hand a battery back and drop its record, answering whether it went back.
   * One hand-back per battery runs at a time; a second request while one runs
   * joins it. Never rejects.
   */
  private release(deviceId: string, reason: ReleaseReason): Promise<boolean> {
    const running = this.releasing.get(deviceId);
    if (running !== undefined) return running;
    const work = this.serializeWrite(deviceId, () => this.runRelease(deviceId, reason)).finally(() => {
      this.releasing.delete(deviceId);
    });
    this.releasing.set(deviceId, work);
    return work;
  }

  private async runRelease(deviceId: string, reason: ReleaseReason): Promise<boolean> {
    const claims = this.claims;
    if (claims.status !== 'loaded') return false;
    const record = claims.records.get(deviceId);
    if (record === undefined) return false;
    const battery = this.getBattery(deviceId);
    if (battery.kind === 'unobserved') {
      this.pending.scheduleRetry(deviceId, reason, { kind: 'unobserved' });
      return false;
    }
    // Its app refuses control, so it refuses the hand-back's writes as well.
    // Nothing is recorded: the hand-back is due again once watch-only ends.
    if (this.isWatchOnly(deviceId)) return false;
    const verdict = this.classifyRelease(deviceId, record, battery);
    if (verdict.kind !== 'release') return this.settleWithoutWrite(claims, deviceId, record, reason, verdict);
    this.claimWrites.noteRestore(deviceId, Date.now());
    try {
      const outcome = await this.actuation.apply({
        kind: 'storage_release',
        deviceId,
        restoreClaimValue: record.previousValue,
      });
      if (!outcome.requested) {
        this.pending.scheduleRetry(deviceId, reason, { kind: 'not_requested' });
        return false;
      }
    } catch (error) {
      this.pending.scheduleRetry(deviceId, reason, { kind: 'write_failed', error });
      return false;
    }
    const recordRemoved = this.forget(claims, deviceId);
    logger.info({
      event: 'battery_control_released',
      deviceId,
      reason,
      restoredClaimValue: record.previousValue,
      recordRemoved,
    });
    return true;
  }

  /**
   * A hand-back that writes nothing, answering whether the battery went back:
   * stopped for good, PELS's own earlier hand-back already landed, held while
   * the claim is contested, or superseded by a takeover.
   */
  private settleWithoutWrite(
    claims: LoadedClaimRecords,
    deviceId: string,
    record: BatteryClaimRecord,
    reason: ReleaseReason,
    verdict: Exclude<ReleaseVerdict, { kind: 'release' }>,
  ): boolean {
    if (verdict.kind === 'terminal') {
      this.pending.stopRetrying(deviceId, reason, verdict.failure);
      return false;
    }
    if (verdict.kind === 'handed_back') {
      this.forgetHandedBack(claims, deviceId, record, reason);
      return true;
    }
    if (verdict.kind === 'contested') {
      this.pending.scheduleRetry(deviceId, reason, { kind: 'claim_contested' });
      return false;
    }
    // Keep the record if the opt-out could not be stored: a restart must
    // still recognize the takeover rather than admit a new claim.
    if (!this.disableAfterTakeover(deviceId)) return false;
    const recordRemoved = this.forget(claims, deviceId);
    logger.info({ event: 'battery_control_claim_superseded', deviceId, reason, recordRemoved });
    // Nothing was handed back: someone else had already taken the battery.
    return false;
  }

  /**
   * What a hand-back of this record would do to the battery as it is now:
   * nothing it could ever do (`terminal`), nothing because PELS's own earlier
   * hand-back already landed (`handed_back`), wait because the battery's claim
   * is contested (`contested`), nothing because someone else took the battery
   * over (`superseded`), or the hand-back.
   */
  private classifyRelease(
    deviceId: string,
    record: BatteryClaimRecord,
    battery: Exclude<BatteryControlRead, { kind: 'unobserved' }>,
  ): ReleaseVerdict {
    if (battery.kind !== 'setpoint') return { kind: 'terminal', failure: battery.kind };
    const failure = resolveTerminalFailure(record, battery);
    if (failure !== undefined) return { kind: 'terminal', failure };
    if (this.showsOwedHandBack(deviceId, record, battery)) return { kind: 'handed_back' };
    const standing = this.claimWrites.readStanding(deviceId, record, battery, Date.now());
    if (standing === 'held') return { kind: 'release' };
    return standing === 'contested' ? { kind: 'contested' } : { kind: 'superseded' };
  }
}
