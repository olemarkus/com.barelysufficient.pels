/**
 * The Main home's home-battery control owner (port:
 * `lib/ports/batteryControlOwner.ts`): claim admission, the durable claim
 * record, and the hand-back. It issues no setpoint. The executor will issue
 * `storage_power` through Main's fenced plan actuator, and only for a battery
 * `admitClaim` admitted; this owner holds no second write path to it.
 *
 * - **Admission.** A claim is admitted only for a `setpoint` battery the owner
 *   has not opted out, that is a Main-home member, while Main may write (not
 *   fenced, not in capacity simulation). Before the first admission the owner
 *   records the claim value the battery holds (`batteryClaimStore.ts`).
 * - **Hand-back.** On opt-out, and at the first boot that finds a record left
 *   by a run that never handed back. Boot recovery from the durable claim
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
import type { BatteryClaimAdmission, BatteryClaimRefusal, BatteryControlOwner } from '../ports/batteryControlOwner';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { StorageActuation } from '../ports/storageCommand';
import { normalizeError } from '../utils/errorUtils';
import { BatteryClaimStore, type BatteryClaimRecord } from './batteryClaimStore';
import {
  isBatteryControlEnabled,
  readBatteryControlSettings,
  type BatteryControlDevicesRead,
} from './batteryControlSettings';
import { backoffDelayMs } from './retryBackoff';

const logger = getLogger('battery');

/** Wait before the next hand-back attempt after the 1st, 2nd, 3rd and every later failure. */
export const BATTERY_RELEASE_RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

/** Consecutive complete device refreshes a battery must be missing from before its record is pruned. */
const PRUNE_AFTER_ABSENT_REFRESHES = 2;

type ReleaseReason = 'opted_out' | 'boot_recovery' | 'retry';

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

/**
 * The claim value to record before PELS first claims a battery: the one it
 * reports now, provided PELS could hand the battery back to it.
 */
const resolveValueToRecord = (
  battery: Extract<BatteryControlRead, { kind: 'setpoint' }>,
): BatteryClaimRefusal | HomeBatteryClaimObservation => {
  const { surface, claim } = battery;
  if ('kind' in claim) return 'claim_unobserved';
  if (claim.value === surface.claim.homeyValue) return 'held_by_other';
  if (!surface.claim.values.includes(claim.value)) return 'claim_value_undeclared';
  return claim;
};

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
  const { surface, claim } = battery;
  if (surface.claim.capabilityId !== record.capabilityId) return { kind: 'terminal', failure: 'capability_mismatch' };
  if (!surface.claim.values.includes(record.previousValue)) {
    return { kind: 'terminal', failure: 'restore_value_undeclared' };
  }
  // The claim is read off the surface's claim capability, which is the record's.
  const takenOver = !('kind' in claim)
    && claim.value !== surface.claim.homeyValue
    && claim.observedAtMs > record.claimedAtMs;
  return takenOver ? { kind: 'superseded' } : { kind: 'release' };
};

export class HomeBatteryControlOwner implements BatteryControlOwner {
  private readonly store: BatteryClaimStore;
  /** The stored claim records; read from the store until a read resolves. */
  private claims: ClaimRecords = { status: 'unavailable' };
  /** Records still owed a hand-back that is not running right now. */
  private readonly pending = new Map<string, PendingHandBack>();
  /** Complete refreshes in a row each recorded battery has been missing from. */
  private readonly absentRefreshes = new Map<string, number>();
  /** The opt-out map, read at construction and on every change to it. */
  private controlDevices: BatteryControlDevicesRead;
  /** Batteries whose hand-back is running. */
  private readonly releasing = new Set<string>();

  constructor(private readonly deps: BatteryControlOwnerDeps) {
    this.store = new BatteryClaimStore(deps.settings);
    this.controlDevices = readBatteryControlSettings(deps.settings);
  }

  admitClaim(deviceId: string): BatteryClaimAdmission {
    const verdict = this.resolveClaim(deviceId);
    return verdict === 'admitted' ? { status: 'admitted' } : { status: 'refused', reason: verdict };
  }

  onSnapshotCommitted(refresh: ObservedDeviceStateRefreshPayload): void {
    const claims = this.loadClaims();
    if (claims.status !== 'loaded') return;
    this.pruneRemovedBatteries(claims, refresh);
    const nowMs = Date.now();
    for (const [deviceId, pending] of this.pending) {
      if (pending.state !== 'due' || pending.nextAttemptAtMs > nowMs || this.releasing.has(deviceId)) continue;
      // An unseen battery has no binding to write through yet.
      if (this.deps.getBattery(deviceId).kind === 'unobserved') continue;
      this.release(deviceId, pending.reason);
    }
  }

  applyControlSettings(): void {
    this.controlDevices = readBatteryControlSettings(this.deps.settings);
    if (this.controlDevices.status !== 'resolved') return;
    const claims = this.loadClaims();
    if (claims.status !== 'loaded') return;
    for (const deviceId of claims.records.keys()) {
      if (!isBatteryControlEnabled(this.controlDevices.devices, deviceId)) this.release(deviceId, 'opted_out');
    }
  }

  private resolveClaim(deviceId: string): BatteryClaimRefusal | 'admitted' {
    const battery = this.deps.getBattery(deviceId);
    if (battery.kind !== 'setpoint') return 'not_drivable';
    const control = this.readControlDevices();
    if (control.status !== 'resolved') return 'control_setting_unreadable';
    if (!isBatteryControlEnabled(control.devices, deviceId)) return 'control_disabled';
    if (!this.deps.isMainHomeMember(deviceId)) return 'not_main_home';
    if (this.deps.isActuationFenced()) return 'actuation_fenced';
    if (this.deps.isCapacityDryRun()) return 'dry_run';
    if (this.releasing.has(deviceId)) return 'release_in_flight';
    const claims = this.loadClaims();
    if (claims.status !== 'loaded') return 'claim_records_unread';
    if (claims.unreadable.has(deviceId)) return 'claim_record_unreadable';
    const record = claims.records.get(deviceId);
    if (record === undefined) return this.recordClaim(claims, deviceId, battery);
    if (record.capabilityId !== battery.surface.claim.capabilityId) return 'claim_record_mismatch';
    // A record a previous run left is adopted rather than handed back: it
    // still names the value the battery held before PELS first claimed it.
    this.pending.delete(deviceId);
    return 'admitted';
  }

  /** Durably record what the battery holds now, before any claim write. */
  private recordClaim(
    claims: LoadedClaimRecords,
    deviceId: string,
    battery: Extract<BatteryControlRead, { kind: 'setpoint' }>,
  ): BatteryClaimRefusal | 'admitted' {
    const observed = resolveValueToRecord(battery);
    if (typeof observed === 'string') return observed;
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
   * The opt-out map. Until a read has resolved, each admission reads again, so
   * a flaked read refuses claims (fail closed) only until the store answers.
   */
  private readControlDevices(): BatteryControlDevicesRead {
    if (this.controlDevices.status !== 'resolved') {
      this.controlDevices = readBatteryControlSettings(this.deps.settings);
    }
    return this.controlDevices;
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

  /** Hand a battery back and drop its record. One hand-back per battery runs at a time. */
  private release(deviceId: string, reason: ReleaseReason): void {
    if (this.releasing.has(deviceId)) return;
    this.releasing.add(deviceId);
    void this.runRelease(deviceId, reason).finally(() => {
      this.releasing.delete(deviceId);
    });
  }

  private async runRelease(deviceId: string, reason: ReleaseReason): Promise<void> {
    const claims = this.claims;
    if (claims.status !== 'loaded') return;
    const record = claims.records.get(deviceId);
    if (record === undefined) return;
    const battery = this.deps.getBattery(deviceId);
    if (battery.kind === 'unobserved') {
      this.scheduleRetry(deviceId, reason, { kind: 'unobserved' });
      return;
    }
    const verdict = classifyRelease(record, battery);
    if (verdict.kind === 'terminal') {
      this.stopRetrying(deviceId, reason, verdict.failure);
      return;
    }
    if (verdict.kind === 'superseded') {
      const recordRemoved = this.forget(claims, deviceId);
      logger.info({ event: 'battery_control_claim_superseded', deviceId, reason, recordRemoved });
      return;
    }
    try {
      const outcome = await this.deps.actuation.apply({
        kind: 'storage_release',
        deviceId,
        restoreClaimValue: record.previousValue,
      });
      if (!outcome.requested) {
        this.scheduleRetry(deviceId, reason, { kind: 'not_requested' });
        return;
      }
    } catch (error) {
      this.scheduleRetry(deviceId, reason, { kind: 'write_failed', error });
      return;
    }
    const recordRemoved = this.forget(claims, deviceId);
    logger.info({
      event: 'battery_control_released',
      deviceId,
      reason,
      restoredClaimValue: record.previousValue,
      recordRemoved,
    });
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
