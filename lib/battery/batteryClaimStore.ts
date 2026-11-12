/**
 * The durable record of every home battery PELS has claimed: one settings key
 * per battery, `battery_control_claim.<deviceId>`, holding the claim capability
 * and the value it held before PELS first claimed it. Written BEFORE the first
 * claim write and removed only after the battery was handed back, so a crash in
 * between leaves the record for the next boot to recover.
 *
 * ## Why `homey.settings` and not `/userdata`
 *
 * The owner ruling puts configuration and mission-critical state in settings
 * and history, learned data and caches in `/userdata`
 * (`notes/settings-key-ownership.md` § "Which store a key lives in"). This is
 * neither configuration nor regenerable: once PELS has overwritten the claim
 * capability, the value it held before exists nowhere else, and a battery with
 * no `device` value (Marstek) cannot be handed back by guessing. It is the same
 * kind of state as the mode-target ownership state, a restore target the app
 * cannot recover, which the ruling keeps in settings by name. Two properties
 * settle it beyond the ruling's wording: the `/userdata` store commits in WAL
 * mode with `synchronous = NORMAL`, so a power cut may roll back the last
 * commit, which for this record is exactly the one that matters; and the record
 * is tiny and written twice per claim, so the cost the `/userdata` store exists
 * to avoid does not arise.
 *
 * ## Why one key per battery
 *
 * As `lib/observer/externalOffHold.ts` explains: a per-key write cannot clobber
 * another battery's record, deleting one is an idempotent `unset`, and the only
 * untrusted read left is the key list. Unlike a hold, a record carries a
 * payload (the value to restore), so a listed key whose value does not parse is
 * a failed read of that one battery's record, never an absent record, and never
 * a reason to stop handing back any other battery.
 *
 * ## A claim-less battery's record
 *
 * A battery driven through its app's actions has no claim capability and no
 * value to restore: its record names the app and exact controlled device,
 * and when PELS took control. Boot recovery uses that durable identity, never
 * a newly paired companion. Older records lacking identity are retained as
 * legacy claims and handed back through their adapter's upgrade policy.
 */
import { getLogger } from '../logging/logger';
import { describeHandBack, toClaimRecord, type ClaimToRecord } from './batteryClaimStanding';
import type { HomeBatteryClaimCapabilityId } from '../../packages/contracts/src/types';
import type { AppActionControlTarget } from '../ports/storageCommand';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX } from '../utils/settingsKeys';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';

/**
 * What PELS owes a battery it claimed, and when PELS admitted the claim:
 *
 * - `claim_capability`: the claim capability and the value to restore. A claim
 *   value observed after the claim, other than Homey's, is someone else taking
 *   the battery over.
 * - `app_actions`: a claim-less battery driven through its app's actions. It
 *   is owed its integration's hand-back actions; nothing it reports can show a
 *   takeover.
 */
export type BatteryClaimRecord =
  | {
    kind: 'claim_capability';
    capabilityId: HomeBatteryClaimCapabilityId;
    previousValue: string;
    claimedAtMs: number;
  }
  | { kind: 'app_actions'; target: AppActionControlTarget; claimedAtMs: number }
  | { kind: 'legacy_app_actions'; claimedAtMs: number };

/** A record's stored form: the claim capability's unchanged since records were first stored. */
const toStoredRecord = (record: BatteryClaimRecord): Record<string, unknown> => {
  if (record.kind === 'app_actions') {
    return { handBack: 'app_actions', target: record.target, claimedAtMs: record.claimedAtMs };
  }
  if (record.kind === 'legacy_app_actions') return { handBack: 'app_actions', claimedAtMs: record.claimedAtMs };
  return { capabilityId: record.capabilityId, previousValue: record.previousValue, claimedAtMs: record.claimedAtMs };
};

/**
 * Stored records. The owner retries unresolved entries on later snapshots. `unavailable` is a key list the SDK
 * did not answer: PELS cannot tell which batteries it owes a hand-back, so the
 * caller retries rather than concluding there are none. A listed record that
 * does not parse affects only its own battery: it is reported in
 * `unreadableDeviceIds`, never read as an absent record.
 */
export type BatteryClaimRecordsRead =
  | {
    status: 'resolved';
    records: ReadonlyMap<string, BatteryClaimRecord>;
    unreadableDeviceIds: readonly string[];
  }
  | { status: 'unavailable' };

/** Every claim capability a record may name: a new one must be listed here, or its records never read back. */
const CLAIM_CAPABILITY_IDS: Readonly<Record<HomeBatteryClaimCapabilityId, true>> = {
  target_power_mode: true,
  control_strategy: true,
  battery_group_charge_mode: true,
};

const isClaimCapabilityId = (value: unknown): value is HomeBatteryClaimCapabilityId => (
  typeof value === 'string' && Object.hasOwn(CLAIM_CAPABILITY_IDS, value)
);

const parseActionTarget = (value: unknown): AppActionControlTarget | null => {
  if (!isUnknownRecord(value)) return null;
  const { appUri, deviceId } = value;
  if (typeof appUri !== 'string' || !/^homey:app:[^\s:]+$/u.test(appUri)
    || typeof deviceId !== 'string' || deviceId.length === 0 || /\s/u.test(deviceId)) return null;
  return { appUri, deviceId };
};

const parseClaimRecord = (value: unknown): BatteryClaimRecord | null => {
  if (!isUnknownRecord(value)) return null;
  const { capabilityId, previousValue, claimedAtMs, handBack } = value;
  if (typeof claimedAtMs !== 'number' || !Number.isFinite(claimedAtMs)) return null;
  if (handBack === 'app_actions') {
    if (capabilityId !== undefined || previousValue !== undefined) return null;
    if (!('target' in value)) return { kind: 'legacy_app_actions', claimedAtMs };
    const target = parseActionTarget(value.target);
    return target === null ? null : { kind: 'app_actions', target, claimedAtMs };
  }
  if (!isClaimCapabilityId(capabilityId) || typeof previousValue !== 'string' || previousValue.length === 0) {
    return null;
  }
  return { kind: 'claim_capability', capabilityId, previousValue, claimedAtMs };
};

const claimKey = (deviceId: string): string => `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}${deviceId}`;

const logger = getLogger('battery');

export class BatteryClaimStore {
  constructor(private readonly settings: SettingsPort) {}

  readAll(): BatteryClaimRecordsRead {
    const keyList = readSettingsKeyList(this.settings);
    if (keyList.status !== 'resolved') return { status: 'unavailable' };
    const records = new Map<string, BatteryClaimRecord>();
    const unreadableDeviceIds: string[] = [];
    for (const key of keyList.keys) {
      if (!key.startsWith(PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX)) continue;
      const deviceId = key.slice(PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX.length);
      if (deviceId.length === 0) continue;
      let record: BatteryClaimRecord | null;
      try {
        record = parseClaimRecord(this.settings.get(key));
      } catch {
        record = null;
      }
      if (record === null) unreadableDeviceIds.push(deviceId);
      else records.set(deviceId, record);
    }
    return { status: 'resolved', records, unreadableDeviceIds };
  }

  /** Persist the first claim before its writer receives authority; no record is admitted on failure. */
  claim(deviceId: string, value: ClaimToRecord): Exclude<BatteryClaimRecord, { kind: 'legacy_app_actions' }> | false {
    const record = toClaimRecord(value, Date.now());
    if (!this.write(deviceId, record)) {
      logger.warn({ event: 'battery_control_claim_record_failed', deviceId });
      return false;
    }
    logger.info({
      event: 'battery_control_claimed', deviceId,
      claimCapabilityId: record.kind === 'claim_capability' ? record.capabilityId : 'app_actions',
      previousClaimValue: describeHandBack(record),
    });
    return record;
  }

  /** Store a record. `false` when the write threw: the caller must not claim. */
  write(deviceId: string, record: BatteryClaimRecord): boolean {
    try {
      this.settings.set(claimKey(deviceId), toStoredRecord(record));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Drop a record after the battery was handed back. `false` when the unset
   * threw; the next boot then repeats the hand-back, which leaves a battery no
   * longer under Homey's claim untouched.
   */
  remove(deviceId: string): boolean {
    try {
      this.settings.unset(claimKey(deviceId));
      return true;
    } catch {
      return false;
    }
  }
}
