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
 * flake signal left is an empty `getKeys()`. Unlike a hold, a record carries a
 * payload (the value to restore), so a listed key whose value does not parse is
 * a failed read of that one battery's record, never an absent record, and never
 * a reason to stop handing back any other battery.
 */
import type { HomeBatteryClaimCapabilityId } from '../../packages/contracts/src/types';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX } from '../utils/settingsKeys';

/**
 * What PELS owes a battery it claimed: the claim capability, the value to
 * restore, and when PELS admitted the claim. A claim value observed after that
 * moment, other than Homey's, is someone else taking the battery over.
 */
export type BatteryClaimRecord = {
  capabilityId: HomeBatteryClaimCapabilityId;
  previousValue: string;
  claimedAtMs: number;
};

/**
 * The stored records, read once per boot. `unavailable` is a key list the SDK
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

const isClaimCapabilityId = (value: unknown): value is HomeBatteryClaimCapabilityId => (
  value === 'target_power_mode' || value === 'control_strategy'
);

const parseClaimRecord = (value: unknown): BatteryClaimRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { capabilityId, previousValue, claimedAtMs } = value as Record<string, unknown>;
  if (!isClaimCapabilityId(capabilityId) || typeof previousValue !== 'string' || previousValue.length === 0) {
    return null;
  }
  if (typeof claimedAtMs !== 'number' || !Number.isFinite(claimedAtMs)) return null;
  return { capabilityId, previousValue, claimedAtMs };
};

const claimKey = (deviceId: string): string => `${PER_DEVICE_BATTERY_CLAIM_KEY_PREFIX}${deviceId}`;

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

  /** Store a record. `false` when the write threw: the caller must not claim. */
  write(deviceId: string, record: BatteryClaimRecord): boolean {
    try {
      this.settings.set(claimKey(deviceId), { ...record });
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
