import {
  createExternalOffHoldPolicy as createPolicy,
  type ExternalOffHoldOptInRead,
  type ExternalOffHoldPolicy,
  type ExternalOffHoldSettingsStore,
} from './externalOffHold';
import {
  LAST_RESORT_DEVICES,
  LAST_RESORT_EXTERNAL_OFF_MIGRATED,
  PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../utils/settingsKeys';
import { readLastResortDevices } from '../../packages/shared-domain/src/settings/lastResortDevices';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { isBooleanMap } from '../utils/appTypeGuards';

/**
 * Reads the opt-in map, classifying every outcome here so the domain never has
 * to (the boundary rule in `AGENTS.md`):
 *  - absent (`undefined`/`null`, including after `unset`) ⇒ a genuine "nobody
 *    opted in", or clearing the setting could never disable the feature;
 *  - throwing or malformed ⇒ the last good map when we have one, since that is
 *    the shape a transient corrupt read takes and silently disabling the feature
 *    would resume everything the user turned off;
 *  - throwing or malformed with no last good map ⇒ `unavailable`, NOT `{}`. At
 *    startup that difference is a wipe: `{}` makes every stored hold look
 *    de-opted, and the policy's constructor would clear them all.
 */
const readOptInMap = (
  store: ExternalOffHoldSettingsStore,
  lastGood: Record<string, boolean> | null,
): ExternalOffHoldOptInRead => {
  const fallback = (): ExternalOffHoldOptInRead => (
    lastGood === null ? { status: 'unavailable' } : { status: 'resolved', optIn: lastGood }
  );
  let raw: unknown;
  try {
    raw = store.get(RESPECT_EXTERNAL_OFF_DEVICES);
  } catch {
    return fallback();
  }
  if (raw === undefined || raw === null) return { status: 'resolved', optIn: {} };
  return isBooleanMap(raw) ? { status: 'resolved', optIn: raw } : fallback();
};

// Existing last-resort setups could only undo PELS's own OFF. Seed the
// standard hold for each one before allowing auto-start. The next accepted ON
// clears that hold in the ordinary observation sweep, including at startup.
function migrateLastResortExternalOff(
  store: ExternalOffHoldSettingsStore, observedOn: ReadonlySet<string>,
): boolean {
  try {
    if (store.get(LAST_RESORT_EXTERNAL_OFF_MIGRATED) === true) return true;
    const list = readSettingsKeyList(store);
    if (list.status !== 'resolved') return false;
    const keys = new Set(list.keys);
    if (keys.has(LAST_RESORT_EXTERNAL_OFF_MIGRATED)) return false;
    const devices = keys.has(LAST_RESORT_DEVICES) ? readLastResortDevices(store.get(LAST_RESORT_DEVICES)) : {};
    if (devices === undefined) return false;
    const ids = Object.keys(devices);
    if (ids.length > 0 && !preserveLastResortHolds(store, ids, keys, observedOn)) return false;
    store.set(LAST_RESORT_EXTERNAL_OFF_MIGRATED, true);
    return true;
  } catch {
    return false;
  }
}

function preserveLastResortHolds(
  store: ExternalOffHoldSettingsStore, ids: readonly string[], keys: ReadonlySet<string>,
  observedOn: ReadonlySet<string>,
): boolean {
  const optIn = keys.has(RESPECT_EXTERNAL_OFF_DEVICES) ? store.get(RESPECT_EXTERNAL_OFF_DEVICES) : {};
  if (!isBooleanMap(optIn)) return false;
  if (ids.some((id) => optIn[id] !== true)) {
    store.set(RESPECT_EXTERNAL_OFF_DEVICES, { ...optIn, ...Object.fromEntries(ids.map((id) => [id, true])) });
  }
  for (const id of ids) {
    const key = `${PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX}${id}`;
    if (!observedOn.has(id) && !keys.has(key)) store.set(key, true);
  }
  return true;
}

/** Build the external-off hold policy over Homey settings. */
export function createExternalOffHoldPolicy(
  store: ExternalOffHoldSettingsStore,
  isConfiguredLastResort: (id: string) => boolean = () => false,
): ExternalOffHoldPolicy {
  // `null` until a read succeeds — an unresolved map must not masquerade as empty.
  let lastGoodOptIn: Record<string, boolean> | null = null;
  const observedOnDuringMigration = new Set<string>();
  let migrated = migrateLastResortExternalOff(store, observedOnDuringMigration);
  const policy = createPolicy({
    store,
    readOptIn: () => {
      const read = readOptInMap(store, lastGoodOptIn);
      if (read.status === 'resolved') lastGoodOptIn = read.optIn;
      return read;
    },
  });
  return {
    ...policy,
    isHeld: (id) => (!migrated && isConfiguredLastResort(id)) || policy.isHeld(id),
    clearHold: (id) => {
      // A later retry must not re-seed the hold after an accepted ON. PELS
      // may itself switch the relay off between the observation and retry.
      if (!migrated && isConfiguredLastResort(id)) observedOnDuringMigration.add(id);
      return policy.clearHold(id);
    },
    heldDeviceIds: () => {
      // This is called by the affirmative ON sweep before each planner input
      // build. Retry here so any newly seeded holds are released on that sweep.
      if (!migrated) {
        // A retry can change the persisted opt-ins before the next read succeeds.
        lastGoodOptIn = null;
        migrated = migrateLastResortExternalOff(store, observedOnDuringMigration);
        if (migrated) observedOnDuringMigration.clear();
      }
      return policy.heldDeviceIds();
    },
  };
}
