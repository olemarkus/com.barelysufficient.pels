import {
  DEFERRED_OBJECTIVES_PERKEY_MIGRATED,
  DEFERRED_OBJECTIVES_SETTINGS,
} from '../../utils/settingsKeys';
import {
  createEmptyDeferredObjectiveSettings,
  normalizeDeferredObjectiveSettings,
  normalizeDeferredObjectiveSettingsEntry,
  type DeferredObjectiveSettingsEntry,
  type DeferredObjectiveSettingsV1,
} from './settings';

// ─── Per-device-key objective store ─────────────────────────────────────────
//
// Each device's deferred objective is persisted under its OWN settings key
// (`deferred_objective.<deviceId>`), holding a single
// `DeferredObjectiveSettingsEntry`. This structurally dissolves the
// whole-map read-modify-write clobber class: a device-scoped create/clear
// touches only that device's key, so a transient-empty/malformed read of one
// key can never drop a SIBLING device's task. There is no shared map to guard.
//
// The legacy plural blob key (`deferred_objectives`, value
// `DeferredObjectiveSettingsV1`) is read ONLY by the one-shot migration below.
// Whole-map consumers read `readAllObjectives`, which assembles the V1 map
// shape from the per-key entries so their iteration logic is unchanged — only
// their source moves from the blob to per-key.

// The minimal settings surface this store needs. Structurally matches the
// `homey.settings` manager (and the test `MockSettings`), so callers pass
// `homey.settings` directly without an adapter.
export type ObjectiveSettingsStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  unset(key: string): void;
  getKeys(): string[];
};

// Singular + dot, deliberately DISTINCT from the plural blob key
// `deferred_objectives` so a prefix scan never collides with the frozen blob
// (the blob key has no trailing dot, so it is not matched by the prefix).
// Mirror of `PER_DEVICE_OBJECTIVE_KEY_PREFIX` in packages/contracts/src/settingsKeys.ts
// (the settings UI can't import lib, so it detects per-device objective changes via
// the contracts copy) — keep both in sync.
export const PER_DEVICE_OBJECTIVE_KEY_PREFIX = 'deferred_objective.';

const perDeviceKey = (deviceId: string): string => `${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${deviceId}`;

const deviceIdFromKey = (key: string): string => key.slice(PER_DEVICE_OBJECTIVE_KEY_PREFIX.length);

/**
 * Read one device's persisted objective, or `undefined` when absent or
 * malformed (the normalizer rejects malformed shapes to `null`).
 */
export const readObjectiveForDevice = (
  store: ObjectiveSettingsStore,
  deviceId: string,
): DeferredObjectiveSettingsEntry | undefined => (
  normalizeDeferredObjectiveSettingsEntry(store.get(perDeviceKey(deviceId))) ?? undefined
);

/**
 * Whether we can TRUST that the device has no objective. True only when the key
 * list is readable (non-empty) AND does not contain the device's key. Both a
 * store-wide transient-empty `getKeys()` (the same flake `migrateBlobToPerKeyIfNeeded`
 * refuses on) and a key that exists but whose value read back `undefined` return
 * false — so a guarded merge refuses rather than treating a flaky read as proof
 * the device is objective-less and overwriting the user's objective.
 */
export const objectiveAbsenceIsTrustworthy = (
  store: ObjectiveSettingsStore,
  deviceId: string,
): boolean => {
  const keys = store.getKeys();
  return keys.length > 0 && !keys.includes(perDeviceKey(deviceId));
};

/**
 * Assemble the legacy V1 map shape from the per-device keys, so whole-map
 * consumers keep iterating `objectivesByDeviceId` unchanged. Enumerates only
 * keys carrying the per-device prefix; skips malformed/empty entries.
 *
 * NEVER falls back to the frozen blob — that is read ONLY by the migration.
 * Reading the blob here would let a cleared device's frozen entry resurrect
 * itself. A transient-empty `getKeys()` therefore yields an empty map for one
 * cycle (no objectives shown) with NO persisted damage; the next read recovers
 * once the SDK returns the real key list.
 */
export const readAllObjectives = (store: ObjectiveSettingsStore): DeferredObjectiveSettingsV1 => {
  const result = createEmptyDeferredObjectiveSettings();
  for (const key of store.getKeys()) {
    if (!key.startsWith(PER_DEVICE_OBJECTIVE_KEY_PREFIX)) continue;
    const deviceId = deviceIdFromKey(key).trim();
    if (!deviceId) continue;
    const entry = normalizeDeferredObjectiveSettingsEntry(store.get(key));
    if (!entry) continue;
    result.objectivesByDeviceId[deviceId] = entry;
  }
  return result;
};

/** Persist one device's objective under its own key. */
export const writeObjectiveForDevice = (
  store: ObjectiveSettingsStore,
  deviceId: string,
  entry: DeferredObjectiveSettingsEntry,
): void => {
  store.set(perDeviceKey(deviceId), entry);
};

/** Remove one device's objective key. */
export const clearObjectiveForDevice = (
  store: ObjectiveSettingsStore,
  deviceId: string,
): void => {
  store.unset(perDeviceKey(deviceId));
};

// A present `deferred_objectives` blob value is trustworthy only when it reads back
// as a structurally-valid V1 (an object carrying an `objectivesByDeviceId` object).
// A flaky Homey read of a present key returns `undefined`/malformed; distinguishing
// that from a genuinely-empty-but-valid blob is what lets the migration consume a
// truly-empty blob WITHOUT erasing a real one on a transient empty/malformed read.
const legacyBlobReadIsTrustworthy = (raw: unknown): boolean => (
  typeof raw === 'object'
  && raw !== null
  && !Array.isArray(raw)
  && typeof (raw as { objectivesByDeviceId?: unknown }).objectivesByDeviceId === 'object'
  && (raw as { objectivesByDeviceId?: unknown }).objectivesByDeviceId !== null
);

/**
 * One-shot, idempotent, abandon-grace-SAFE migration from the legacy plural
 * blob (`deferred_objectives`) to per-device keys.
 *
 * The key safety property is NO-RESURRECTION: a device the user clears *after*
 * migrating must never reappear. The only way to guarantee that against a flaky
 * single SDK read of the done-marker (per feedback_homey_sdk_unreliable) is to
 * CONSUME the source — once the blob's entries are copied, the blob is unset, so
 * "blob present + no per-key + marker-absent" (which is indistinguishable from a
 * post-clear marker misread while the blob is frozen) can no longer occur.
 *
 * Two safety properties, resolved by CONSUMING the source — the blob is unset
 * once fully copied, so its mere PRESENCE means "migration not yet complete":
 *
 *  - NO-RESURRECTION: a device the user clears *after* migrating must never
 *    reappear. After a full migration the blob is gone, so step 3 (blob absent)
 *    marks done and never re-reads a source — even if the done-marker `get`
 *    flakes to falsy (per feedback_homey_sdk_unreliable) and zero per-device
 *    keys survive (the user cleared their only task).
 *  - NO-PARTIAL-LOSS: if a prior boot crashed mid-copy (some per-keys written,
 *    blob not yet unset, marker not set), the blob is still present, so this
 *    runs again and the ABSENT-ONLY copy finishes the remaining entries instead
 *    of marking done with tasks left behind.
 *
 * Decision order (load-bearing for data safety):
 *
 *  1. Marker truthy → return (already migrated).
 *  2. `getKeys()` empty → return WITHOUT the marker. PELS always has settings
 *     keys, so an empty list is the transient-empty-store signal; retry next
 *     boot rather than record a false "migrated" against an unreadable store.
 *  3. Blob key ABSENT → nothing to migrate: a fresh install, or the blob was
 *     consumed by a completed migration (whose marker-set may have flaked). Set
 *     the marker and return — there is no source to copy or resurrect from.
 *  4. Blob present but normalizes to ZERO entries → either a genuinely-empty
 *     blob or a flaky single-key read. Return WITHOUT consuming or marking, so a
 *     flaky read can never lose tasks; retry next boot. (`readAllObjectives` is
 *     per-key-only, so the user sees correct empty state meanwhile.)
 *  5. ABSENT-ONLY copy each blob entry whose per-device key does not yet exist
 *     (so a never-overwrite a newer per-key, and a partial prior copy resumes
 *     cleanly), then UNSET the blob (consume the source), then set the marker.
 */
export const migrateBlobToPerKeyIfNeeded = (store: ObjectiveSettingsStore): void => {
  if (store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED)) return;
  const keys = store.getKeys();
  // (2) Abandon-grace: an empty key list means the store read is untrustworthy
  // right now. Retry next boot rather than commit "migrated" against it.
  if (keys.length === 0) return;

  // (3) No source blob → fresh install, or a completed migration already
  // consumed it (so a marker-flake boot lands here and re-asserts the marker
  // without resurrecting a since-cleared task — the blob is gone).
  if (!keys.includes(DEFERRED_OBJECTIVES_SETTINGS)) {
    store.set(DEFERRED_OBJECTIVES_PERKEY_MIGRATED, true);
    return;
  }

  // (4) Read the RAW blob and require it to be STRUCTURALLY VALID before trusting
  // it. The blob key is listed (step 3), but a present key whose value transiently
  // reads `undefined`/malformed is the same Homey-settings flake the per-key write
  // guards refuse on — consuming on that would erase the only legacy copy before any
  // per-key is written (data loss). So:
  //  - undefined/malformed (no `objectivesByDeviceId` object) → flaky read → return
  //    WITHOUT consuming or marking; retry next boot.
  //  - a structurally-valid V1 (an `objectivesByDeviceId` object) → trustworthy. Its
  //    entries (possibly zero — a genuinely-empty blob the user cleared pre-upgrade)
  //    are migrated + the source consumed + marked below, so the migration completes
  //    (otherwise the marker stays unset forever and the marker-gated back-fill never
  //    runs).
  const rawBlob = store.get(DEFERRED_OBJECTIVES_SETTINGS);
  if (!legacyBlobReadIsTrustworthy(rawBlob)) return;
  const blob = normalizeDeferredObjectiveSettings(rawBlob);
  const entries = Object.entries(blob.objectivesByDeviceId);

  // (5) Absent-only copy: skip any device whose per-key already EXISTS — decided
  // by key PRESENCE (`getKeys`), not a value read, so a transient/malformed read
  // of an already-copied key on a resumed migration can't make it look absent and
  // re-copy (overwrite) it from the blob. A resumed partial copy finishes the
  // remaining devices without clobbering. (No-op when the blob is empty.) Then
  // consume the source + mark done.
  const presentKeys = new Set(keys.filter((key) => key.startsWith(PER_DEVICE_OBJECTIVE_KEY_PREFIX)));
  for (const [deviceId, entry] of entries) {
    if (!presentKeys.has(perDeviceKey(deviceId))) {
      writeObjectiveForDevice(store, deviceId, entry);
    }
  }
  store.unset(DEFERRED_OBJECTIVES_SETTINGS);
  store.set(DEFERRED_OBJECTIVES_PERKEY_MIGRATED, true);
};
