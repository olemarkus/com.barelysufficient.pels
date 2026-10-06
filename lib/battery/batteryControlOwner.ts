/**
 * The Main home's home-battery control owner (port:
 * `lib/ports/batteryControlOwner.ts`): claim admission, the durable claim
 * record, the hand-back, and what each battery has shown about following a
 * setpoint (`batteryVerification.ts`). It issues no setpoint: the executor's
 * storage lane issues `storage_power` through Main's fenced plan actuator, and
 * only through `dispatchSetpoint`, which serializes admission and the complete
 * write with hand-back. `readControl` is the planner input's read of all of it.
 *
 * - **Admission.** A claim is admitted only for a `setpoint` battery the owner
 *   has not opted out, that is a Main-home member, while Main may write (not
 *   fenced, not in capacity simulation). Before the first admission the owner
 *   records the claim value the battery holds (`batteryClaimStore.ts`).
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
 * - **Stale claims.** A battery observed under another claim value is handed
 *   back anyway unless that observation is dated after PELS claimed it: a
 *   snapshot older than the claim still shows the pre-claim value, and only a
 *   newer one means someone else took the battery over.
 * - **Retries.** A failed hand-back is retried on committed snapshots with a
 *   per-battery backoff. A terminal one (a restore value or claim capability
 *   the battery no longer declares, or a battery PELS can only observe) is
 *   logged once and keeps its record without retrying.
 *
 * A leaf domain: it imports only `lib/ports`, `lib/utils`, `lib/logging` and
 * the shared packages.
 */
import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';
import type { HomeBatteryClaimObservation, HomeBatteryControlSurface } from '../../packages/contracts/src/types';
import { getLogger } from '../logging/logger';
import type {
  BatteryClaimAdmission,
  BatteryClaimRefusal,
  BatteryControlOwner,
  BatteryHandBackOutcome,
  BatteryLeverRead,
  BatterySetpointOutcome,
  StorageReleaseReason,
} from '../ports/batteryControlOwner';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { StorageActuation } from '../ports/storageCommand';
import { normalizeError } from '../utils/errorUtils';
import { BATTERY_CONTROL_DEVICES } from '../utils/settingsKeys';
import { BatteryClaimStore, type BatteryClaimRecord } from './batteryClaimStore';
import { isBatteryControlEnabled } from '../../packages/shared-domain/src/settings/batteryControlDevices';
import type { BatteryManagedSettings } from './batteryControlSettings';
import { backoffDelayMs } from './retryBackoff';
import { BatteryVerificationLedger } from './batteryVerification';

const logger = getLogger('battery');

/** Wait before the next hand-back attempt after the 1st, 2nd, 3rd and every later failure. */
export const BATTERY_RELEASE_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

/** Consecutive complete device refreshes a battery must be missing from before its record is pruned. */
const PRUNE_AFTER_ABSENT_REFRESHES = 2;

type ReleaseReason = 'opted_out' | 'boot_recovery' | 'retry' | StorageReleaseReason;

/** Why a hand-back can never succeed against the battery as it is now. */
type TerminalReleaseFailure = 'observe_only' | 'capability_mismatch' | 'restore_value_undeclared';

/** Why this hand-back attempt failed; a later one may succeed. */
type RetryableReleaseFailure =
  | { kind: 'unobserved' }
  | { kind: 'not_requested' }
  | { kind: 'write_failed'; error: unknown };

/** A record still owed a hand-back: due for an attempt, or stopped by a terminal failure. */
type PendingHandBack =
  | { state: 'due'; reason: ReleaseReason; failures: number; nextAttemptAtMs: number }
  | { state: 'terminal'; failure: TerminalReleaseFailure };

type SetpointSurface = Extract<HomeBatteryControlSurface, { kind: 'setpoint' }>;

/** Whether an admission check holds Main's write fence against the battery. */
type FencePolicy = 'fence_applies' | 'fence_ignored';

/** The claim value a battery last reported on its surface's claim capability, or that it has reported none. */
export type HomeBatteryClaimRead = { kind: 'unreported' } | HomeBatteryClaimObservation;

/**
 * A device as the owner reads it, resolved by setup from the transport
 * snapshot: not observed (yet), observed but not drivable (an observe-only
 * battery, or no battery at all), or drivable through its setpoint surface.
 */
export type BatteryControlRead =
  | { kind: 'unobserved' }
  | { kind: 'observe_only' }
  | { kind: 'setpoint'; surface: SetpointSurface; claim: HomeBatteryClaimRead };

export type BatteryControlOwnerDeps = {
  settings: SettingsPort;
  /** The owner's Managed map; the owner's `isManaged` and admission answer from it. */
  managed: BatteryManagedSettings;
  /** The write seam. The owner dispatches only hand-backs through it. */
  actuation: StorageActuation;
  getBattery: (deviceId: string) => BatteryControlRead;
  /** Whether the device belongs to the Main home; false while membership is not resolved. */
  isMainHomeMember: (deviceId: string) => boolean;
  /** Main's write fence: a home torn down, ownership unsettled, or a superseded apply. */
  isActuationFenced: () => boolean;
  /** Capacity simulation (dry run): nothing may be written. */
  isCapacityDryRun: () => boolean;
};

type LoadedClaimRecords = {
  status: 'loaded';
  records: Map<string, BatteryClaimRecord>;
  unreadable: ReadonlySet<string>;
};

/** The stored claim records, or that their key list has not read cleanly yet. */
type ClaimRecords = LoadedClaimRecords | { status: 'unavailable' };

type SetpointBatteryRead = Extract<BatteryControlRead, { kind: 'setpoint' }>;

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

/**
 * The claim value to record before PELS first claims a battery: the one it
 * reports now, provided PELS could hand the battery back to it.
 */
const resolveValueToRecord = (battery: SetpointBatteryRead): BatteryClaimRefusal | HomeBatteryClaimObservation => {
  const { surface, claim } = battery;
  if ('kind' in claim) return 'claim_unobserved';
  if (claim.value === surface.claim.homeyValue) return 'held_by_other';
  if (!surface.claim.values.includes(claim.value)) return 'claim_value_undeclared';
  return claim;
};

const isTakenOver = (record: BatteryClaimRecord, battery: SetpointBatteryRead): boolean => (
  battery.surface.claim.capabilityId === record.capabilityId
  && !('kind' in battery.claim)
  && battery.claim.value !== battery.surface.claim.homeyValue
  && battery.claim.observedAtMs > record.claimedAtMs
);

/**
 * What a hand-back of this record would do to the battery as it is now:
 * nothing it could ever do (`terminal`), nothing because someone else took the
 * battery over after PELS claimed it (`superseded`), or the hand-back.
 */
const classifyRelease = (
  record: BatteryClaimRecord,
  battery: Exclude<BatteryControlRead, { kind: 'unobserved' }>,
): { kind: 'release' } | { kind: 'superseded' } | { kind: 'terminal'; failure: TerminalReleaseFailure } => {
  if (battery.kind === 'observe_only') return { kind: 'terminal', failure: 'observe_only' };
  const { surface } = battery;
  if (surface.claim.capabilityId !== record.capabilityId) return { kind: 'terminal', failure: 'capability_mismatch' };
  if (!surface.claim.values.includes(record.previousValue)) {
    return { kind: 'terminal', failure: 'restore_value_undeclared' };
  }
  return isTakenOver(record, battery) ? { kind: 'superseded' } : { kind: 'release' };
};



export class HomeBatteryControlOwner implements BatteryControlOwner {
  private readonly store: BatteryClaimStore;
  /** The stored claim records; read from the store until a read resolves. */
  private claims: ClaimRecords = { status: 'unavailable' };
  /** Records still owed a hand-back that is not running right now. */
  private readonly pending = new Map<string, PendingHandBack>();
  /** Complete refreshes in a row each recorded battery has been missing from. */
  private readonly absentRefreshes = new Map<string, number>();
  /** Hand-backs running now, each answering whether the battery went back. */
  private readonly releasing = new Map<string, Promise<boolean>>();
  /** Batteries whose Managed PELS turned off this run because the owner took them over. */
  private readonly takenOver = new Set<string>();
  private readonly writes = new Map<string, Promise<void>>();
  readonly verification = new BatteryVerificationLedger();

  constructor(private readonly deps: BatteryControlOwnerDeps) {
    this.store = new BatteryClaimStore(deps.settings);
    // Settle the map the owner starts from, so the first change to it is told
    // apart from it (`applyControlSettings`).
    deps.managed.read();
  }

  admitClaim(deviceId: string): BatteryClaimAdmission {
    const check = this.checkClaim(deviceId, 'fence_applies');
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

  dispatchSetpoint(deviceId: string, write: () => Promise<number | 'skipped'>): Promise<BatterySetpointOutcome> {
    return this.serializeWrite(deviceId, async () => {
      const admission = this.admitClaim(deviceId);
      if (admission.status === 'refused') return admission;
      return { status: 'dispatched', setpointW: await write() };
    });
  }

  wasTakenOver(deviceId: string): boolean {
    return this.takenOver.has(deviceId);
  }

  isManaged(deviceId: string): boolean {
    return this.deps.managed.isManaged(deviceId);
  }

  /** Store the owner's Managed choice for this battery, then apply it as any settings change is applied. */
  setControlEnabled(deviceId: string, enabled: boolean): void {
    const control = this.deps.managed.reload();
    if (control.status !== 'resolved') throw new Error('Battery control settings could not be read. Try again.');
    this.deps.settings.set(BATTERY_CONTROL_DEVICES, { ...control.devices, [deviceId]: enabled });
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
    try {
      this.setControlEnabled(deviceId, false);
      this.takenOver.add(deviceId);
      logger.info({ event: 'battery_control_claim_lost', deviceId });
      return true;
    } catch (error) {
      logger.warn({ event: 'battery_control_opt_out_failed', deviceId, err: normalizeError(error) });
      return false;
    }
  }

  private hasUnappliedReenable(deviceId: string): boolean {
    const held = this.deps.managed.read();
    const stored = this.deps.managed.readStored();
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
    const battery = this.deps.getBattery(deviceId);
    if (battery.kind !== 'setpoint') return { kind: 'none' };
    const { surface, claim } = battery;
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
      handBackDeferred: this.releasing.has(deviceId) || this.isHandBackWaiting(deviceId, nowMs)
        || (record !== undefined && isTakenOver(record, battery)),
      claimEngaged: !('kind' in claim) && claim.value === surface.claim.homeyValue,
      // Main's write fence is a moment (a superseded apply, a teardown), not a
      // reason to hand the battery back: the fenced actuator already holds
      // every write while it lasts.
      admissible: typeof this.checkClaim(deviceId, 'fence_ignored') !== 'string',
      verdict: verification.verdict,
    };
  }

  async releaseClaim(deviceId: string, reason: StorageReleaseReason): Promise<BatteryHandBackOutcome> {
    if (this.isHandBackWaiting(deviceId, Date.now())) return 'not_released';
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
    if (this.deps.isCapacityDryRun()) {
      for (const deviceId of claims.records.keys()) {
        if (!this.pending.has(deviceId) && !this.releasing.has(deviceId)) void this.release(deviceId, 'not_admissible');
      }
    }
    const nowMs = Date.now();
    for (const [deviceId, pending] of this.pending) {
      if (pending.state !== 'due' || pending.nextAttemptAtMs > nowMs || this.releasing.has(deviceId)) continue;
      // An unseen battery has no binding to write through yet.
      if (this.deps.getBattery(deviceId).kind === 'unobserved') continue;
      void this.release(deviceId, pending.reason);
    }
  }

  private disableTakenOverClaims(claims: LoadedClaimRecords): void {
    for (const [deviceId, record] of claims.records) {
      const battery = this.deps.getBattery(deviceId);
      if (battery.kind === 'setpoint' && isTakenOver(record, battery) && !this.releasing.has(deviceId)) {
        this.disableAfterTakeover(deviceId);
      }
    }
  }

  applyControlSettings(): void {
    // A failed read keeps the last map that read cleanly (`BatteryManagedSettings`),
    // so a battery PELS holds stays managed, and stays in the plan, through it.
    const previous = this.deps.managed.read();
    const control = this.deps.managed.reload();
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
    const battery = this.deps.getBattery(deviceId);
    if (record === undefined || battery.kind !== 'setpoint' || !isTakenOver(record, battery)) return;
    const recordRemoved = this.forget(claims, deviceId);
    if (!recordRemoved) {
      // The record stays stored and would read as the takeover again at the
      // next boot, turning Managed straight back off.
      logger.warn({ event: 'battery_control_takeover_record_remove_failed', deviceId });
      return;
    }
    logger.info({ event: 'battery_control_reenabled_after_takeover', deviceId });
  }

  /**
   * A hand-back waiting out its retry back-off, or stopped for good: the plan
   * asking again changes nothing, and must not turn the back-off into a retry
   * on every rebuild.
   */
  private isHandBackWaiting(deviceId: string, nowMs: number): boolean {
    const pending = this.pending.get(deviceId);
    return pending !== undefined && (pending.state === 'terminal' || pending.nextAttemptAtMs > nowMs);
  }

  /** Every admission check, writing nothing. */
  private checkClaim(deviceId: string, fence: FencePolicy): BatteryClaimRefusal | ClaimCheck {
    const battery = this.deps.getBattery(deviceId);
    if (battery.kind !== 'setpoint') return 'not_drivable';
    const control = this.deps.managed.read();
    if (control.status !== 'resolved') return 'control_setting_unreadable';
    if (!isBatteryControlEnabled(control.devices, deviceId)) return 'control_disabled';
    if (!this.deps.isMainHomeMember(deviceId)) return 'not_main_home';
    if (fence === 'fence_applies' && this.deps.isActuationFenced()) return 'actuation_fenced';
    if (this.deps.isCapacityDryRun()) return 'dry_run';
    if (this.releasing.has(deviceId) || this.isHandBackWaiting(deviceId, Date.now())) return 'release_in_flight';
    const claims = this.loadClaims();
    if (claims.status !== 'loaded') return 'claim_records_unread';
    if (claims.unreadable.has(deviceId)) return 'claim_record_unreadable';
    const record = claims.records.get(deviceId);
    if (record !== undefined) {
      return this.checkRecordedClaim(record, battery);
    }
    const value = resolveValueToRecord(battery);
    return typeof value === 'string' ? value : { kind: 'recordable', claims, battery, value };
  }

  private checkRecordedClaim(
    record: BatteryClaimRecord,
    battery: SetpointBatteryRead,
  ): BatteryClaimRefusal | ClaimCheck {
    if (record.capabilityId !== battery.surface.claim.capabilityId) return 'claim_record_mismatch';
    return isTakenOver(record, battery) ? 'claim_lost' : { kind: 'recorded' };
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
      this.pending.set(deviceId, { state: 'due', reason: 'boot_recovery', failures: 0, nextAttemptAtMs: 0 });
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
      this.pending.set(deviceId, { state: 'due', reason: 'boot_recovery', failures: 0, nextAttemptAtMs: 0 });
    }
    this.claims = { ...claims, unreadable };
  }

  /**
   * Drop the record of a battery missing from two complete refreshes in a row.
   * An empty refresh proves nothing about any one battery and counts for
   * nothing; a failed one never reaches here.
   */
  private pruneRemovedBatteries(claims: LoadedClaimRecords, refresh: ObservedDeviceStateRefreshPayload): void {
    if (refresh.entries.length === 0) return;
    const present = new Set(refresh.entries.map((entry) => entry.observed.id));
    for (const deviceId of [...claims.records.keys()]) {
      if (present.has(deviceId)) {
        this.absentRefreshes.delete(deviceId);
        continue;
      }
      const absent = (this.absentRefreshes.get(deviceId) ?? 0) + 1;
      this.absentRefreshes.set(deviceId, absent);
      if (absent < PRUNE_AFTER_ABSENT_REFRESHES || this.releasing.has(deviceId)) continue;
      this.forget(claims, deviceId);
      logger.info({ event: 'battery_control_claim_pruned', deviceId, reason: 'device_removed' });
    }
  }

  private forget(claims: LoadedClaimRecords, deviceId: string): boolean {
    claims.records.delete(deviceId);
    this.pending.delete(deviceId);
    this.absentRefreshes.delete(deviceId);
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
    const battery = this.deps.getBattery(deviceId);
    if (battery.kind === 'unobserved') {
      this.scheduleRetry(deviceId, reason, { kind: 'unobserved' });
      return false;
    }
    const verdict = classifyRelease(record, battery);
    if (verdict.kind === 'terminal') {
      this.stopRetrying(deviceId, reason, verdict.failure);
      return false;
    }
    if (verdict.kind === 'superseded') {
      // Keep the record if the opt-out could not be stored: a restart must
      // still recognize the takeover rather than admit a new claim.
      if (!this.disableAfterTakeover(deviceId)) return false;
      const recordRemoved = this.forget(claims, deviceId);
      logger.info({ event: 'battery_control_claim_superseded', deviceId, reason, recordRemoved });
      // Nothing was handed back: someone else had already taken the battery.
      return false;
    }
    try {
      const outcome = await this.deps.actuation.apply({
        kind: 'storage_release',
        deviceId,
        restoreClaimValue: record.previousValue,
      });
      if (!outcome.requested) {
        this.scheduleRetry(deviceId, reason, { kind: 'not_requested' });
        return false;
      }
    } catch (error) {
      this.scheduleRetry(deviceId, reason, { kind: 'write_failed', error });
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

  private scheduleRetry(deviceId: string, reason: ReleaseReason, failure: RetryableReleaseFailure): void {
    const previous = this.pending.get(deviceId);
    const failures = (previous?.state === 'due' ? previous.failures : 0) + 1;
    const nextAttemptAtMs = Date.now() + backoffDelayMs(BATTERY_RELEASE_RETRY_BACKOFF_MS, failures);
    this.pending.set(deviceId, {
      state: 'due',
      reason: reason === 'boot_recovery' ? reason : 'retry',
      failures,
      nextAttemptAtMs,
    });
    logger.warn({
      event: 'battery_control_release_failed',
      deviceId,
      reason,
      failure: failure.kind,
      terminal: false,
      nextAttemptAtMs,
      ...(failure.kind === 'write_failed' ? { err: normalizeError(failure.error) } : {}),
    });
  }

  /** A hand-back that cannot succeed: logged once, the record kept, no retry. */
  private stopRetrying(deviceId: string, reason: ReleaseReason, failure: TerminalReleaseFailure): void {
    const previous = this.pending.get(deviceId);
    this.pending.set(deviceId, { state: 'terminal', failure });
    if (previous?.state === 'terminal' && previous.failure === failure) return;
    logger.warn({ event: 'battery_control_release_failed', deviceId, reason, failure, terminal: true });
  }
}
