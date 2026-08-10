import type Homey from 'homey';
import { getLogger } from '../lib/logging/logger';
import { normalizeDeviceControlProfiles } from '../lib/utils/deviceControlProfiles';
import { normalizeDeviceTargetPowerConfigs } from '../lib/utils/targetPowerConfig';
import { DEVICE_CONTROL_PROFILES, DEVICE_TARGET_POWER_CONFIGS } from '../lib/utils/settingsKeys';

const repairLogger = getLogger('startup/stepped-profile-repair');

type RepairSettingsPort = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  getKeys(): unknown;
};

type SettingRead =
  | { state: 'resolved'; entries: Record<string, unknown> }
  | { state: 'absent' }
  | { state: 'unavailable' };

/**
 * One-time repair of stepped configurations that can never run a device.
 *
 * PELS used to accept a stepped profile with no steps, or with nothing but an
 * off step, and a target-power range that produces no ladder. Such a device is
 * classified as a stepped load PELS can pause but never resume. The save paths
 * reject those now; this clears the ones already written, per device, by
 * dropping the entry — which returns that device to its default control model,
 * the same state it had before anyone opened the stepped editor.
 *
 * Silent by design: the owner never chose this state, and a notification about
 * a setting reverting itself would cost more attention than it is worth. The
 * structured log carries the audit trail.
 *
 * Both settings are read raw rather than through the app's loaded snapshot,
 * because the boot guard (`isDeviceControlProfiles`) rejects the whole map when
 * any single entry is bad — the app may be running on `{}` while the stored map
 * still holds every other device's good profile. Writing the normalized map
 * back is what recovers them.
 *
 * That amplification is also why this defers rather than declaring victory on a
 * suspect read: skipping the repair does not merely leave one stale entry, it
 * leaves every device's stored ladder unreadable on every later boot. So a key
 * the key-list vouches for that reads empty or malformed answers `deferred`,
 * and the caller withholds the done-marker so the next boot retries. A key the
 * list does not mention is genuinely absent — nothing to repair, and no reason
 * to keep trying.
 */
export const repairUnusableSteppedConfigurations = (
  homey: Pick<Homey.App['homey'], 'settings'>,
): 'applied' | 'deferred' => {
  const settings = homey.settings as unknown as RepairSettingsPort;
  const outcomes = [
    repairSetting({
      settings,
      key: DEVICE_CONTROL_PROFILES,
      normalize: (raw) => normalizeDeviceControlProfiles(raw) ?? {},
      kind: 'control_profile',
    }),
    repairSetting({
      settings,
      key: DEVICE_TARGET_POWER_CONFIGS,
      normalize: normalizeDeviceTargetPowerConfigs,
      kind: 'target_power_config',
    }),
  ];
  return outcomes.includes('deferred') ? 'deferred' : 'applied';
};

const repairSetting = (params: {
  settings: RepairSettingsPort;
  key: string;
  normalize: (raw: unknown) => Record<string, unknown>;
  kind: 'control_profile' | 'target_power_config';
}): 'applied' | 'deferred' => {
  const read = readSettingEntries(params.settings, params.key);
  if (read.state === 'unavailable') {
    repairLogger.warn({
      event: 'unusable_stepped_configuration_repair_deferred',
      kind: params.kind,
      settingKey: params.key,
    });
    return 'deferred';
  }
  if (read.state === 'absent') return 'applied';

  const storedIds = Object.keys(read.entries);
  const normalized = params.normalize(read.entries);
  const droppedDeviceIds = storedIds.filter((deviceId) => !Object.hasOwn(normalized, deviceId));
  if (droppedDeviceIds.length === 0) return 'applied';
  try {
    params.settings.set(params.key, normalized);
  } catch (error) {
    // A failed write must not escape: this runs inside a startup step that
    // rethrows, so an exception here aborts boot outright. Defer instead — the
    // marker stays unset and the next boot repairs.
    repairLogger.warn({
      event: 'unusable_stepped_configuration_repair_deferred',
      kind: params.kind,
      settingKey: params.key,
      cause: 'write_failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return 'deferred';
  }
  repairLogger.info({
    event: 'unusable_stepped_configuration_repaired',
    kind: params.kind,
    settingKey: params.key,
    droppedDeviceIds,
    remainingDeviceCount: Object.keys(normalized).length,
  });
  return 'applied';
};

/**
 * `ManagerSettings.get` answers an unset key with `null`, so absence is
 * classified on both `null` and `undefined` and then confirmed against the key
 * list — the rule in `setup/AGENTS.md`. A throw is a failed read, not an empty
 * one, and an EMPTY key list is not proof of a pristine install: a Homey that
 * momentarily reports no keys at all is the miss `migrateBlobToPerKeyIfNeeded`
 * already guards against, so it defers rather than declaring absence.
 */
const readSettingEntries = (settings: RepairSettingsPort, key: string): SettingRead => {
  try {
    const raw = settings.get(key);
    const entries = parseSettingRecord(raw);
    if (entries) return { state: 'resolved', entries };
    if (raw === undefined || raw === null) {
      const keys = settings.getKeys();
      if (
        Array.isArray(keys)
        && keys.length > 0
        && keys.every((entry): entry is string => typeof entry === 'string')
        && !keys.includes(key)
      ) {
        return { state: 'absent' };
      }
    }
  } catch {
    // A failed read is indistinguishable from a transient miss; both defer.
  }
  return { state: 'unavailable' };
};

/**
 * A settings record, whether it is stored as an object or as a JSON-encoded
 * string.
 *
 * The string form is real: writing through the Homey API's app-setting endpoint
 * stores the value JSON-encoded, and both `parseRecordSetting`
 * (`setup/appSettingsHelpers.ts`) and `normalizeDeviceTargetPowerConfigs`
 * accept it. Treating it as an unreadable value here would have deferred the
 * repair on every boot of an install written that way — warning each time and
 * never clearing the entry it exists to clear.
 */
const parseSettingRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};
