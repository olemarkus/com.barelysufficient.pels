import { PER_DEVICE_OBJECTIVE_KEY_PREFIX } from '../../utils/settingsKeys';
import { readSettingsKeyList } from '../../utils/settingsKeyList';
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
// touches only that device's key, so a malformed read of one key can never
// drop a SIBLING device's task. There is no shared map to guard.
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

export type ObjectiveForDeviceRead =
  | { state: 'none' }
  | { state: 'present'; entry: DeferredObjectiveSettingsEntry }
  | { state: 'unavailable' };

/**
 * One device's objective as a three-state read, for a reader that must not
 * mistake a read gap for "no task": a transient read, or a stored value the
 * normalizer rejects (the store holds something it cannot name), is
 * `unavailable`, never `none`.
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
 * Whether the device has a Smart task in progress, as a three-state read: the
 * gate on the device's temperature choice must refuse when it cannot tell, so
 * a transient read is `unavailable`, never `none`.
 */
export const readSmartTaskInProgress = (
  store: ObjectiveSettingsStore,
  deviceId: string,
  nowMs: number,
): SmartTaskInProgressRead => {
  const read = readObjectiveForDeviceState(store, deviceId);
  if (read.state !== 'present') return read.state;
  return isSmartTaskInProgress(read.entry, nowMs) ? 'in_progress' : 'none';
};

/**
 * Whether we can TRUST that the device has no objective: the key list resolves
 * and does not contain the device's key. Homey answers a never-written key by
 * leaving it out of `getKeys()`, so an empty list is a trusted absence too. A
 * key list that throws or answers malformed, and a key that is listed but whose
 * value read back `undefined`, return false, so a guarded merge refuses rather
 * than overwrite an objective it could not read.
 */
export const objectiveAbsenceIsTrustworthy = (
  store: ObjectiveSettingsStore,
  deviceId: string,
): boolean => {
  const keyList = readSettingsKeyList(store);
  return keyList.status === 'resolved' && !keyList.keys.includes(perDeviceKey(deviceId));
};

/**
 * Assemble the roster from the per-device keys. Enumerates only keys carrying
 * the per-device prefix; skips malformed/empty entries. A decision that must
 * not read a failed key-list read or a malformed listed value as "no task"
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
 * read gap for an empty home. The key list is sampled exactly once; a thrown or
 * malformed list, or an unreadable listed objective value, becomes an explicit
 * unavailable result instead of an optimistic empty roster. An empty list is a
 * store with no tasks.
 */
/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
export const readDeferredObjectiveRoster = (
  store: ObjectiveSettingsStore,
): DeferredObjectiveRosterRead => {
  const keyList = readSettingsKeyList(store);
  if (keyList.status !== 'resolved') return { status: 'unavailable' };
  const settings = createEmptyDeferredObjectiveRoster();
  try {
    for (const key of keyList.keys) {
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
