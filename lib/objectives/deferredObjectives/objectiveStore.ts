import { PER_DEVICE_OBJECTIVE_KEY_PREFIX } from '../../utils/settingsKeys';
import {
  createEmptyDeferredObjectiveRoster,
  isSmartTaskInProgress,
  isSmartTaskOpen,
  normalizeDeferredObjectiveSettingsEntry,
  type SmartTaskInProgressRead,
} from '../../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import type {
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveRoster,
} from '../../../packages/contracts/src/deferredObjectiveSettings';

// ─── Per-device-key objective store ─────────────────────────────────────────
//
// Each device's deferred objective is persisted under its OWN settings key
// (`deferred_objective.<deviceId>`), holding a single
// `DeferredObjectiveSettingsEntry`. This structurally dissolves the
// whole-map read-modify-write clobber class: a device-scoped create/clear
// touches only that device's key, so a transient-empty/malformed read of one
// key can never drop a SIBLING device's task. There is no shared map to guard.
//
// These keys are the only place a task is stored. Whole-map consumers read
// `readAllObjectives` or `readDeferredObjectiveRoster`, which assemble the
// in-memory roster from them; the roster itself is never persisted. Anything
// outside PELS creates and ends tasks through the smart-task routes, never by
// writing these keys.

// The minimal settings surface this store needs. Structurally matches the
// `homey.settings` manager (and the test `MockSettings`), so callers pass
// `homey.settings` directly without an adapter.
export type ObjectiveSettingsStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  unset(key: string): void;
  getKeys(): string[];
};

// Mirror the one-hour abandon window used by the smart-task active-plan,
// history, and priority caches. A transient settings gap keeps the last trusted
// roster, but a persistent outage must eventually stop stale tasks from driving
// lifecycle and control decisions.
const TRUSTED_ROSTER_ABANDON_GRACE_MS = 60 * 60 * 1000;

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
 * Whether the device currently has an OPEN deferred objective (a smart task).
 * Enabled entries always count; disabled future entries also count because the
 * user has paused a still-open task. Disabled past entries do not count — they
 * are completed/abandoned history and must not suppress a fresh held-back
 * rescue forever.
 */
export const hasOpenDeferredObjective = (
  store: ObjectiveSettingsStore,
  deviceId: string,
  nowMs: number,
): boolean => {
  const entry = readObjectiveForDevice(store, deviceId);
  return entry !== undefined && isSmartTaskOpen(entry, nowMs);
};

/**
 * Whether the device has a Smart task in progress, as a three-state read: the
 * gate on the device's temperature choice must refuse when it cannot tell, so
 * a transient read is `unavailable`, never `none`. A present entry the
 * normalizer rejects is unavailable too: the store holds something for the
 * device, and this read cannot say what.
 */
export const readSmartTaskInProgress = (
  store: ObjectiveSettingsStore,
  deviceId: string,
  nowMs: number,
): SmartTaskInProgressRead => {
  try {
    const raw = store.get(perDeviceKey(deviceId));
    const entry = normalizeDeferredObjectiveSettingsEntry(raw);
    if (entry) return isSmartTaskInProgress(entry, nowMs) ? 'in_progress' : 'none';
    if (raw !== null && raw !== undefined) return 'unavailable';
    return objectiveAbsenceIsTrustworthy(store, deviceId) ? 'none' : 'unavailable';
  } catch {
    return 'unavailable';
  }
};

export type ObjectiveForDeviceRead =
  | { state: 'none' }
  | { state: 'present'; entry: DeferredObjectiveSettingsEntry }
  | { state: 'unavailable' };

/**
 * One device's objective as a three-state read, for a reader that reports
 * absence as a fact (a diagnostics report): a transient read or a stored value
 * the normalizer rejects is `unavailable`, never `none`.
 */
export const readObjectiveForDeviceState = (
  store: ObjectiveSettingsStore,
  deviceId: string,
): ObjectiveForDeviceRead => {
  try {
    const raw = store.get(perDeviceKey(deviceId));
    const entry = normalizeDeferredObjectiveSettingsEntry(raw);
    if (entry) return { state: 'present', entry };
    if (raw !== null && raw !== undefined) return { state: 'unavailable' };
    return objectiveAbsenceIsTrustworthy(store, deviceId) ? { state: 'none' } : { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
};

/**
 * Whether we can TRUST that the device has no objective. True only when the key
 * list is readable (non-empty) AND does not contain the device's key. Both a
 * store-wide transient-empty `getKeys()` and a key that exists but whose value
 * read back `undefined` return false — so a guarded merge refuses rather than
 * treating a flaky read as proof the device is objective-less and overwriting
 * the user's objective.
 */
export const objectiveAbsenceIsTrustworthy = (
  store: ObjectiveSettingsStore,
  deviceId: string,
): boolean => {
  const keys = store.getKeys();
  return keys.length > 0 && !keys.includes(perDeviceKey(deviceId));
};

/**
 * Whether the store-wide key list is trustworthy right now. PELS always has
 * settings keys, so an empty `getKeys()` is the transient-empty-store flake
 * (the same signal `objectiveAbsenceIsTrustworthy` refuses on). Callers that interpret an empty
 * `readAllObjectives` result as "genuinely zero enabled objectives" must gate
 * on this first — otherwise a flaky empty read is mistaken for real emptiness.
 */
export const objectiveKeyListIsTrustworthy = (store: ObjectiveSettingsStore): boolean => (
  store.getKeys().length > 0
);

/**
 * Assemble the roster from the per-device keys. Enumerates only keys carrying
 * the per-device prefix; skips malformed/empty entries. A transient-empty
 * `getKeys()` therefore yields an empty roster for one cycle (no objectives
 * shown) with NO persisted damage; the next read recovers once the SDK returns
 * the real key list. A decision that must not read that gap as an empty home
 * uses `readDeferredObjectiveRoster` instead.
 */
/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
export const readAllObjectives = (store: ObjectiveSettingsStore): DeferredObjectiveRoster => {
  const result = createEmptyDeferredObjectiveRoster();
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
/* eslint-enable functional/immutable-data */

export type DeferredObjectiveRosterRead = {
  status: 'resolved';
  settings: DeferredObjectiveRoster;
} | {
  status: 'unavailable';
};

/**
 * Read the whole objective roster for a decision that must not mistake an SDK
 * read gap for an empty home. The key list is sampled exactly once; an empty or
 * thrown list, or an unreadable listed objective value, becomes an explicit
 * unavailable result instead of an optimistic empty roster.
 */
/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
export const readDeferredObjectiveRoster = (
  store: ObjectiveSettingsStore,
): DeferredObjectiveRosterRead => {
  let rawKeys: unknown;
  try {
    // Homey's SDK typing promises `string[]`, but this is an external boundary:
    // runtime failures have returned nullish and malformed values as well as
    // throwing. Classify the actual value before any array operation.
    rawKeys = store.getKeys();
  } catch {
    return { status: 'unavailable' };
  }
  if (!Array.isArray(rawKeys) || !rawKeys.every((key) => typeof key === 'string')) {
    return { status: 'unavailable' };
  }
  const keys = rawKeys;
  if (keys.length === 0) return { status: 'unavailable' };
  const settings = createEmptyDeferredObjectiveRoster();
  try {
    for (const key of keys) {
      if (!key.startsWith(PER_DEVICE_OBJECTIVE_KEY_PREFIX)) continue;
      const deviceId = deviceIdFromKey(key).trim();
      if (!deviceId) return { status: 'unavailable' };
      const entry = normalizeDeferredObjectiveSettingsEntry(store.get(key));
      if (!entry) return { status: 'unavailable' };
      settings.objectivesByDeviceId[deviceId] = entry;
    }
  } catch {
    return { status: 'unavailable' };
  }
  return { status: 'resolved', settings };
};
/* eslint-enable functional/immutable-data */

/**
 * Whether the device has an open Smart task (`isSmartTaskOpen`), for the
 * settings UI's create preview, which must not offer a create the write will
 * refuse. Three states like `readSmartTaskInProgress`: an entry the normalizer
 * rejects, or an absence the key list cannot confirm, is `unavailable`, never
 * `none`, so a read gap never reads as a device free for a new task.
 */
export const readSmartTaskOpen = (
  store: ObjectiveSettingsStore,
  deviceId: string,
  nowMs: number,
): 'open' | 'none' | 'unavailable' => {
  try {
    const raw = store.get(perDeviceKey(deviceId));
    const entry = normalizeDeferredObjectiveSettingsEntry(raw);
    if (entry) return isSmartTaskOpen(entry, nowMs) ? 'open' : 'none';
    if (raw !== null && raw !== undefined) return 'unavailable';
    return objectiveAbsenceIsTrustworthy(store, deviceId) ? 'none' : 'unavailable';
  } catch {
    return 'unavailable';
  }
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

/**
 * Runtime roster reader for control decisions. A healthy read replaces the
 * cached semantic settings snapshot; a thrown/malformed/partial SDK read keeps
 * the last trusted roster for one abandon-grace window. A persistent outage
 * then resolves to explicit unavailability (`undefined`) until a healthy read
 * recovers. Before the first trusted snapshot, unavailability is explicit
 * immediately so callers skip the cycle instead of treating the home as having
 * no tasks.
 */
export const createTrustedDeferredObjectiveSettingsReader = (
  store: ObjectiveSettingsStore,
): (() => DeferredObjectiveRoster | undefined) => {
  let lastTrusted: DeferredObjectiveRoster | undefined;
  let lastTrustedAtMs: number | undefined;
  const readUnavailable = (): DeferredObjectiveRoster | undefined => {
    if (lastTrusted === undefined || lastTrustedAtMs === undefined) return undefined;
    const nowMs = Date.now();
    if (!Number.isFinite(nowMs)) return undefined;
    return nowMs - lastTrustedAtMs < TRUSTED_ROSTER_ABANDON_GRACE_MS
      ? lastTrusted
      : undefined;
  };
  return () => {
    const roster = readDeferredObjectiveRoster(store);
    if (roster.status === 'unavailable') return readUnavailable();
    const nowMs = Date.now();
    lastTrustedAtMs = Number.isFinite(nowMs) ? nowMs : undefined;
    lastTrusted = roster.settings;
    return lastTrusted;
  };
};
