/**
 * Owns the **external-off hold**: the per-device state recording that an opted-in
 * device was turned off outside PELS, independent of the current plan, and that
 * PELS must therefore leave it off until it is turned on again.
 *
 * Ownership split:
 *  - **This module** owns the hold state, the opt-in read, and persistence. It is
 *    a pure observer leaf (`no-observer-to-peer`): its only import is the settings
 *    key registry, so `lib/device`, `lib/plan`, `lib/executor`, and `setup` may
 *    all depend on it.
 *  - **`setup/externalOffHoldAdapter.ts`** binds `homey.settings` to the store
 *    port below and resolves the opt-in read. It knows Homey; this module does not.
 *  - **`setup/externalOffHoldDetection.ts`** owns the provenance question ("was
 *    this OFF ours?") — the actually hard part of this feature, since PELS turns
 *    devices off all the time. This module never asks why a device is off.
 *  - **`setup/appInit/toPlanDevice.ts`** resolves the stored hold against live
 *    observed state into the flat `externalOffHoldActive` plan-input bit.
 *
 * ## A hold is a key, and the key has no payload
 *
 * Each hold is one settings key (`external_off_hold.<deviceId>`) whose PRESENCE
 * is the entire fact. Nothing about a hold varies per device: it is on or it is
 * not. So the stored value is a constant `true` placeholder — Homey settings
 * need something — and no code reads it.
 *
 * Two consequences worth stating, because both used to cost a lot of code:
 *
 *  - **There is no value to validate.** An absent payload cannot be malformed,
 *    truncated, `NaN`, or tampered into an extra field. The only untrusted read
 *    left is the key LIST, classified once in `readKeyList`.
 *  - **There is no shared document to clobber.** The previous shape kept every
 *    hold in one `external_off_holds` blob whose write full-replaced it, so a
 *    blob PELS could not read made *any* write a potential wipe of every other
 *    device's hold. Defending that took an abandon-grace window, a
 *    written-before marker, a tombstone set for releases recorded against an
 *    unread blob, an abandoned-blob flag, and a read-before-save ordering rule
 *    inside a re-entrant settle pass — seven pieces of interacting state. A
 *    per-key write cannot reach another device, so none of it is needed and
 *    this module now holds no state at all between calls.
 *
 * Same move as `lib/objectives/deferredObjectives/objectiveStore.ts`, whose
 * migration order `migrateExternalOffHoldsToPerKey` below mirrors.
 *
 * Invariants callers may rely on:
 *  - **Unreadable is not "no hold".** An untrustworthy key list must not answer
 *    `isHeld === false`, because that answer IS the resume this feature exists
 *    to prevent, so it fails closed for opted-in devices. Every consumer pairs
 *    `isHeld` with "still observed off", so a device that is actually running is
 *    never affected.
 *  - **An empty `getKeys()` is a flake, not an empty store.** PELS always has
 *    settings keys, so an empty list means the read is untrustworthy right now
 *    (`feedback_homey_sdk_unreliable`). Nothing is concluded from it.
 *  - Holds are never pruned on snapshot absence. There is no device-removal
 *    grace in the codebase today, and a stale key for a removed device is inert
 *    and bounded by device count.
 */
import {
  EXTERNAL_OFF_HOLDS,
  EXTERNAL_OFF_HOLDS_INITIALIZED,
  EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED,
  PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX,
} from '../utils/settingsKeys';

/**
 * The minimal settings surface this store needs. Structurally matches the
 * `homey.settings` manager (and the test `MockSettings`), so the adapter passes
 * `homey.settings` straight through. `get` is here for the migration only —
 * reading a hold is a key-list question, never a value read.
 */
export type ExternalOffHoldSettingsStore = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  unset: (key: string) => void;
  getKeys: () => string[];
};

/**
 * The opt-in read as a typed semantic result: "nobody opted in" and "the map
 * could not be read" are different answers and the adapter owns the distinction.
 * Collapsing them is a wipe — an unavailable read would make every stored hold
 * look de-opted, and `releaseDeOptedHolds` would clear them all.
 */
export type ExternalOffHoldOptInRead =
  | { status: 'resolved'; optIn: Record<string, boolean> }
  | { status: 'unavailable' };

export type ExternalOffHoldDeps = {
  store: ExternalOffHoldSettingsStore;
  /**
   * Reads the per-device opt-in map. Called live rather than cached so a
   * just-toggled setting takes effect immediately; it is only reached once per
   * candidate observation, never per device per plan cycle.
   */
  readOptIn: () => ExternalOffHoldOptInRead;
};

/**
 * The single surface every consumer types against. Pairs the two *separate*
 * persisted concepts — configuration (`isEnabledForDevice`) and runtime state
 * (`isHeld`) — behind one read surface, because every consumer needs both while
 * neither may ask *why* a hold exists.
 */
export type ExternalOffHoldPolicy = {
  isEnabledForDevice: (deviceId: string) => boolean;
  isHeld: (deviceId: string) => boolean;
  /** Starts a hold. Returns `true` only when one was newly created. */
  startHold: (deviceId: string) => boolean;
  /** Clears a hold. Returns `true` only when one was actually present. */
  clearHold: (deviceId: string) => boolean;
  heldDeviceIds: () => string[];
  /**
   * Drops any hold whose device is no longer opted in. Returns the released
   * device ids. Run at construction as well as on a settings change, so an
   * opt-in cleared while the app was down cannot leave a hold honoured forever.
   */
  releaseDeOptedHolds: () => string[];
};

/**
 * The value written under a hold key. Never read — the key's presence is the
 * hold. A constant placeholder rather than a timestamp, so there is no per-hold
 * data to drift, to validate, or to tempt a future reader into treating as
 * meaningful.
 */
const HOLD_PLACEHOLDER = true;

/**
 * Attempts a hold write, retrying a bounded number of times before giving up.
 * `homey.settings.set` is synchronous and has been seen to throw transiently
 * under contention, so an immediate retry recovers the common case without
 * retaining anything. It is deliberately NOT the old pending-write machinery:
 * this returns an honest `false` when every attempt fails rather than reporting
 * a hold it did not store, and the caller logs no hold started.
 */
const HOLD_WRITE_ATTEMPTS = 3;

const writeWithRetry = (store: ExternalOffHoldSettingsStore, key: string): boolean => {
  for (let attempt = 0; attempt < HOLD_WRITE_ATTEMPTS; attempt += 1) {
    try {
      store.set(key, HOLD_PLACEHOLDER);
      return true;
    } catch {
      // Next attempt, or fall out to `false` below.
    }
  }
  return false;
};

const perDeviceKey = (deviceId: string): string => (
  `${PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX}${deviceId}`
);

/**
 * The key list, classified — the ONLY untrusted read this module makes. PELS
 * always has settings keys, so an empty list is the transient-empty-store flake
 * rather than a store with nothing in it. The SDK has returned nullish and
 * malformed values here as well as throwing, so the value is classified before
 * any array operation.
 */
type KeyListRead =
  | { status: 'resolved'; keys: readonly string[] }
  | { status: 'unavailable' };

const readKeyList = (store: ExternalOffHoldSettingsStore): KeyListRead => {
  let raw: unknown;
  try {
    raw = store.getKeys();
  } catch {
    return { status: 'unavailable' };
  }
  if (!Array.isArray(raw) || !raw.every((key) => typeof key === 'string')) {
    return { status: 'unavailable' };
  }
  if (raw.length === 0) return { status: 'unavailable' };
  return { status: 'resolved', keys: raw };
};

export const createExternalOffHoldPolicy = (
  deps: ExternalOffHoldDeps,
): ExternalOffHoldPolicy => {
  const { store } = deps;

  /**
   * The store must be migrated before it can be read, so every entry point
   * asserts it rather than trusting a caller to have sequenced it. This is not
   * belt-and-braces: `migrateExternalOffHoldsToPerKey` returns silently when the
   * marker, the key list, the blob read, or a copy write fails, and a policy
   * built after such a deferral reads only per-device keys — so an upgrading
   * owner's still-in-the-blob holds would answer "not held" for the rest of the
   * boot, and the next meter-driven plan would resume devices they left off.
   * Asserting it here means the SDK recovering mid-boot heals the migration on
   * the next read instead of on the next restart. It costs one `get` of an
   * already-set marker once migrated, which is the steady state forever after.
   */
  const ensureMigrated = (): void => {
    migrateExternalOffHoldsToPerKey(store);
  };

  const isEnabledForDevice = (deviceId: string): boolean => {
    const read = deps.readOptIn();
    return read.status === 'resolved' && read.optIn[deviceId] === true;
  };

  /**
   * Whether a key list we could not read might carry this device. This is the
   * fail-closed guess `isHeld` answers while the list is unreadable: an
   * unresolved opt-in read cannot rule any device out, so every device stays in.
   */
  const mayBeHeldWhenUnreadable = (deviceId: string): boolean => {
    const read = deps.readOptIn();
    return read.status !== 'resolved' || read.optIn[deviceId] === true;
  };

  const heldDeviceIds = (): string[] => {
    ensureMigrated();
    const keyList = readKeyList(store);
    if (keyList.status !== 'resolved') return [];
    return keyList.keys
      .filter((key) => key.startsWith(PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX))
      // Sliced, never trimmed: the id has to round-trip back through
      // `perDeviceKey`, because `dropDeOptedHolds` feeds these straight to
      // `clearHold`. A normalised id would rebuild a key that is not the one on
      // disk, and the unset would silently miss.
      .map((key) => key.slice(PER_DEVICE_EXTERNAL_OFF_HOLD_KEY_PREFIX.length))
      // Drops the bare prefix with nothing after it.
      .filter((deviceId) => deviceId.length > 0);
  };

  const clearHold = (deviceId: string): boolean => {
    ensureMigrated();
    const keyList = readKeyList(store);
    const wasHeld = keyList.status === 'resolved'
      && keyList.keys.includes(perDeviceKey(deviceId));
    try {
      // Unconditional and idempotent: unsetting a key that is not there costs
      // nothing and cannot touch another device, so there is no read to get
      // right first and no pending-write state to carry. A throw leaves the key
      // in place; the observed-ON sweep calls this every plan cycle for every
      // device it sees on, so the retry is the ordinary path rather than
      // machinery this module has to own.
      store.unset(perDeviceKey(deviceId));
    } catch {
      return false;
    }
    // `false` under an unreadable key list means one lost debug line, not a lost
    // release — the unset above already happened, whatever the list said.
    return wasHeld;
  };

  const dropDeOptedHolds = (): string[] => {
    const held = heldDeviceIds();
    // Nothing held ⇒ nothing to reconcile, and no reason to spend a settings
    // read. This is the case for everyone who has not opted a device in.
    if (held.length === 0) return [];
    const read = deps.readOptIn();
    // An unavailable opt-in read is not "nobody opted in". Releasing on it would
    // clear every stored hold, permanently resuming devices the user turned off.
    // Skip; the next call reconciles once the read resolves.
    if (read.status !== 'resolved') return [];
    return held
      .filter((deviceId) => read.optIn[deviceId] !== true)
      .filter((deviceId) => clearHold(deviceId));
  };

  // An opt-in cleared while the app was down would otherwise leave the stored
  // hold honoured forever — there is no other path that reconciles the two.
  dropDeOptedHolds();

  return {
    isEnabledForDevice,
    isHeld: (deviceId) => {
      ensureMigrated();
      const keyList = readKeyList(store);
      if (keyList.status === 'resolved') return keyList.keys.includes(perDeviceKey(deviceId));
      // The key list could not be read: an opted-in device may have a hold we
      // simply could not see, and answering "not held" is exactly the resume
      // this feature exists to prevent. Harmless for a running device — every
      // consumer pairs this with "still observed off". When the OPT-IN map is
      // unreadable too (a total settings outage — both sit behind the same
      // settings service), we cannot even tell which devices those are, so every
      // device fails closed.
      return mayBeHeldWhenUnreadable(deviceId);
    },
    startHold: (deviceId) => {
      ensureMigrated();
      const keyList = readKeyList(store);
      if (keyList.status === 'resolved' && keyList.keys.includes(perDeviceKey(deviceId))) {
        return false;
      }
      // Written on a resolved absence AND on an unreadable list. Under an
      // unreadable list the fail-safe direction is to record: a hold that
      // should not exist is dropped by the next observed-ON sweep, whereas a
      // hold that should exist and is missing resumes a device against the
      // owner's wish. Re-writing an existing hold is a no-op on the stored
      // fact, because the value carries nothing.
      //
      // This is the one write in the module that cannot be retried later. A
      // hold starts on a ON->OFF EDGE (`shouldStartHold`), and an edge happens
      // once — nothing re-derives it, so a dropped write loses the hold for
      // good and the next eligible plan turns the device back on. `clearHold`
      // has no such problem: the observed-ON sweep repeats it every plan cycle.
      // So this write, and only this write, retries in place.
      return writeWithRetry(store, perDeviceKey(deviceId));
    },
    clearHold,
    heldDeviceIds: () => {
      // Reconcile opt-outs here too, not only on the settings-change edge. That
      // edge's read can fail, and nothing else would retry it — the device would
      // stay held until the user changed a setting again or turned it on by hand.
      // This runs once per plan cycle (the pull-path release sweep) and costs
      // one key-list read while no device is held.
      dropDeOptedHolds();
      return heldDeviceIds();
    },
    releaseDeOptedHolds: dropDeOptedHolds,
  };
};

/**
 * One-shot migration of the legacy `external_off_holds` blob into per-device
 * keys. Mirrors `migrateBlobToPerKeyIfNeeded` in
 * `lib/objectives/deferredObjectives/objectiveStore.ts`; the decision order is
 * load-bearing for data safety:
 *
 *  1. Marker truthy → return (already migrated).
 *  2. `getKeys()` unusable or empty → return WITHOUT the marker. PELS always has
 *     settings keys, so that is the transient-empty-store signal; retry next
 *     boot rather than record a false "migrated" against an unreadable store.
 *  3. Blob key ABSENT → nothing to migrate: a fresh install, or the blob was
 *     consumed by a completed migration whose marker-set flaked. Set the marker
 *     and return — there is no source to copy or resurrect from, so a device the
 *     user released after migrating can never reappear.
 *  4. Blob present but its value does not read back as the V1 shape → a flaky or
 *     malformed read. Return WITHOUT consuming or marking; retry next boot,
 *     rather than erase the only legacy copy before any per-key is written.
 *  5. ABSENT-ONLY copy each held device whose per-device key does not yet exist
 *     (so a partial prior copy resumes without clobbering), then UNSET the blob
 *     and its now-dead written-before marker, then set the migrated marker.
 */
export const migrateExternalOffHoldsToPerKey = (
  store: ExternalOffHoldSettingsStore,
): void => {
  let marker: unknown;
  try {
    marker = store.get(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED);
  } catch {
    return;
  }
  if (marker === true) return;

  const keyList = readKeyList(store);
  if (keyList.status !== 'resolved') return;

  if (!keyList.keys.includes(EXTERNAL_OFF_HOLDS)) {
    try {
      store.set(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED, true);
    } catch {
      // Retry next boot. Step 3 is reached again and stays correct: the blob is
      // still absent, so nothing is resurrected.
    }
    return;
  }

  let rawBlob: unknown;
  try {
    rawBlob = store.get(EXTERNAL_OFF_HOLDS);
  } catch {
    return;
  }
  const heldDeviceIds = readLegacyBlobDeviceIds(rawBlob);
  if (!heldDeviceIds) return;

  const present = new Set(keyList.keys);
  try {
    for (const deviceId of heldDeviceIds) {
      // Decided by key PRESENCE, so a resumed partial migration finishes the
      // remaining devices without rewriting the ones already copied.
      if (present.has(perDeviceKey(deviceId))) continue;
      store.set(perDeviceKey(deviceId), HOLD_PLACEHOLDER);
    }
    store.unset(EXTERNAL_OFF_HOLDS);
    // Dead with the blob: it existed only to tell a fresh install from a
    // transient miss of a blob that no longer exists.
    store.unset(EXTERNAL_OFF_HOLDS_INITIALIZED);
    store.set(EXTERNAL_OFF_HOLDS_PERKEY_MIGRATED, true);
  } catch {
    // A throw part-way leaves the blob in place and the marker unset, so the
    // next boot re-runs and the absent-only copy finishes what is left.
  }
};

/**
 * The device ids the legacy blob recorded a hold for, or `null` when the value
 * is not a structurally valid V1. A present key whose value transiently reads
 * back `undefined` or malformed is the same SDK flake the per-key writes refuse
 * on — consuming on that would erase the only legacy copy. A valid blob with
 * zero entries is a real answer (the user cleared their holds pre-upgrade) and
 * migrates fine.
 *
 * Only the ids are taken: the blob's per-entry `sinceMs` had no reader then and
 * has no destination now. It is still REQUIRED to be a finite positive number
 * for the entry to count, because that is exactly what the v1 loader demanded —
 * a migration has to reproduce what the old code would have loaded, no more. A
 * per-entry failure skips that entry and the rest still migrate, matching the
 * v1 loader again; refusing the whole blob instead would stall the migration
 * forever and re-run it on every boot.
 */
const readLegacyBlobDeviceIds = (raw: unknown): string[] | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as { version?: unknown; entriesByDeviceId?: unknown };
  if (candidate.version !== 1) return null;
  const map = candidate.entriesByDeviceId;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const heldSinceIsValid = (entry: unknown): boolean => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const { sinceMs } = entry as { sinceMs?: unknown };
    return typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs > 0;
  };
  return Object.entries(map)
    .filter(([deviceId, entry]) => deviceId.length > 0 && heldSinceIsValid(entry))
    .map(([deviceId]) => deviceId);
};
