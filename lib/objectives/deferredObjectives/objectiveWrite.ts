import { applyDeferredObjectiveChange } from './objectiveChange';
import type { DeferredObjectiveChangeInput } from './objectiveChange';
import type { DeferredObjectiveActivePlanRecorder } from './activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from './planHistory';
import {
  clearObjectiveForDevice as clearObjectiveKey,
  migrateBlobToPerKeyIfNeeded,
  objectiveAbsenceIsTrustworthy,
  readObjectiveForDevice,
  writeObjectiveForDevice,
  type ObjectiveSettingsStore,
} from './objectiveStore';
import type { DeferredObjectiveSettingsEntry } from './settings';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { DEFERRED_OBJECTIVES_PERKEY_MIGRATED } from '../../utils/settingsKeys';

// Device-scoped writes only proceed once the per-key migration is COMPLETE. Until
// then a device's objective may still live only in the un-migrated legacy blob, so
// per-key absence isn't trustworthy — a write would fork a fresh per-key the
// absent-only migration then skips, losing the blob copy's target/deadline/rescue.
// Run the (idempotent, cheap-once-done) migration first; if it's still deferred (a
// transient empty-getKeys flake), refuse so the caller retries rather than write
// against an un-migrated device. Returns true when it's safe to proceed.
const ensureMigrated = (deps: DeferredObjectiveDeviceWriteDeps): boolean => {
  migrateBlobToPerKeyIfNeeded(deps.store);
  return Boolean(deps.store.get(DEFERRED_OBJECTIVES_PERKEY_MIGRATED));
};

// ─── Device-scoped operations (per-device-key storage) ───────────────────────
//
// Each device's objective is persisted under its OWN settings key (see
// `objectiveStore.ts`). Callers express device-level intent ("set this device's
// objective", "clear this device's objective"); they never touch a shared map.
// Because a per-key `set`/`unset` cannot drop a sibling device's entry, the
// whole-map clobber class is structurally dissolved — there is no
// read-modify-write to guard, so these ops cannot fail-as-clobber and have no
// refusal branch. The transient-empty protection the old hardened primitive
// provided is now inherent: a spurious empty read of one key surfaces no
// objective for that one device for a single cycle with NO persisted damage,
// and self-heals on the next clean read.

// The outcome of a device-scoped write. A write either PERSISTED, or REFUSED.
// Two refusal reasons are retryable transients (an un-confirmable per-key
// migration, or an untrustworthy absence read — see the guards below); both map
// to the same user-facing "couldn't save just now, retry" framing. The third —
// `device_in_sub_home` — is a hard v1-scope rejection, NOT retryable: smart
// tasks are planned against the MAIN home's meter budget (hard cap, daily
// budget overlay, concurrent-eligible sharing), so a task on a device that
// belongs to a separate-meter sub-home would be planned against the wrong
// meter. Callers surface it with its own copy, never the retry framing. The
// old `void` return hid refusals, so callers reported success while nothing
// was written.
export type ObjectiveWriteOutcome =
  | { persisted: true }
  | { persisted: false; reason: 'migration_deferred' | 'untrusted_absence' | 'device_in_sub_home' };

export type DeferredObjectiveDeviceWriteDeps = {
  store: ObjectiveSettingsStore;
  planHistoryRecorder: DeferredObjectivePlanHistoryRecorder;
  activePlanRecorder: DeferredObjectiveActivePlanRecorder;
  rebuildPlan: () => void;
  nowMs: number;
  // Multi-home v1 scope gate, wired by `buildDeferredObjectiveDeviceWriteDeps`
  // from the membership service: `false` means the device belongs to a
  // separate-meter sub-home and an UPSERT must refuse (`device_in_sub_home`) —
  // every write lane (widget create, settings-UI edit, Flow cards, rescue)
  // funnels through these deps, so this is the defence-in-depth chokepoint.
  // Optional: absent (bare test harnesses) or with no sub-homes configured the
  // membership resolves main for everything, so every gate passes unchanged.
  // Clearing is deliberately NOT gated — a user must always be able to clear a
  // task whose device was later moved to a sub-home.
  isDeviceInMainHome?: (deviceId: string) => boolean;
  // Topic-gated structured debug sink (gated on the `deferred_objectives` debug
  // topic), wired by `buildDeferredObjectiveDeviceWriteDeps`. Optional so test
  // harnesses can omit it. Used only to surface refusals (see `refuse`).
  debugStructured?: StructuredDebugEmitter;
};

// A device-scoped write op = 'upsert' | 'rescue' | 'clear', carried on the
// refusal event so a `deferred_objectives`-debug trace can tell which lane
// refused.
type ObjectiveWriteOp = 'upsert' | 'rescue' | 'clear';

// Emit a topic-gated debug breadcrumb for a refused write and return the
// outcome. A refusal is a self-healing transient (the guards leave persisted
// state intact and the caller surfaces a retry), so it is a diagnostic payload
// — the project's `debugStructured` emitter (info/error go through the prose
// logger; structured debug goes here) is the right sink, NOT an error-sink log.
// Without this, a transient refusal was visible only as the user-facing card
// error and left no server-side trace to correlate against.
const refuse = (
  deps: DeferredObjectiveDeviceWriteDeps,
  op: ObjectiveWriteOp,
  deviceId: string,
  reason: 'migration_deferred' | 'untrusted_absence' | 'device_in_sub_home',
): ObjectiveWriteOutcome => {
  deps.debugStructured?.({ event: 'objective_write_refused', op, deviceId, reason });
  return { persisted: false, reason };
};

// Notify both recorders, flush them, and request a plan rebuild. This is the
// single chokepoint every objective write funnels through so the active-plan
// hero, the plan-history audit trail, and the planner stay consistent — there
// is no parallel notify/flush/rebuild sequence to drift from.
const notifyAndRebuild = (
  deps: DeferredObjectiveDeviceWriteDeps,
  change: Omit<DeferredObjectiveChangeInput, 'activePlanRecorder' | 'planHistoryRecorder'>,
): void => {
  applyDeferredObjectiveChange({
    ...change,
    activePlanRecorder: deps.activePlanRecorder,
    planHistoryRecorder: deps.planHistoryRecorder,
  });
  deps.activePlanRecorder.flushIfDirty();
  deps.planHistoryRecorder.flushIfDirty();
  deps.rebuildPlan();
};

/**
 * Set (create or replace) a device's deferred objective.
 *
 * The caller is responsible for validating/normalising `entry` (e.g. via the
 * shared `normalizeDeferredObjectiveSettingsEntry`) before calling this.
 *
 * A pre-existing `prevEntry.rescue` is preserved by default (`rescue:
 * 'preserve'`): the rescue cards promise a standing permission sticks until the
 * user changes it or clears the task, and an `entry` rebuilt from a
 * goal/deadline alone (e.g. the create widget) would otherwise wipe it. Pass
 * `rescue: 'replace'` when the caller is authoritatively setting the rescue
 * field (e.g. the allow-rescue card, which can also CLEAR a permission) so its
 * `entry.rescue` — including `undefined` — is written verbatim.
 */
export const upsertObjectiveForDevice = (
  deps: DeferredObjectiveDeviceWriteDeps,
  params: {
    deviceId: string;
    deviceName: string | null;
    entry: DeferredObjectiveSettingsEntry;
    rescue?: 'preserve' | 'replace';
  },
): ObjectiveWriteOutcome => {
  // v1 scope gate FIRST: a sub-home device's rejection is a hard, honest "not
  // available here", never the transient retry framing the guards below map to.
  // See the dep's doc — clear (`clearObjectiveForDevice`) is intentionally
  // ungated so a task on a relocated device can always be removed.
  if (deps.isDeviceInMainHome?.(params.deviceId) === false) {
    return refuse(deps, 'upsert', params.deviceId, 'device_in_sub_home');
  }
  if (!ensureMigrated(deps)) return refuse(deps, 'upsert', params.deviceId, 'migration_deferred');
  const { deviceId, deviceName } = params;
  const rescuePolicy = params.rescue ?? 'preserve';
  const prevEntry = readObjectiveForDevice(deps.store, deviceId);
  // Flaky-read guard: only proceed as a genuine create when the absence is
  // TRUSTWORTHY (key list readable AND key absent). A present-but-unreadable key
  // OR a store-wide empty `getKeys()` both mean "can't trust this is objective-less",
  // so refuse rather than overwrite the user's objective / drop a preserved rescue.
  if (prevEntry === undefined && !objectiveAbsenceIsTrustworthy(deps.store, deviceId)) {
    return refuse(deps, 'upsert', deviceId, 'untrusted_absence');
  }
  // Preserve a standing rescue permission unless the caller is authoritative
  // about rescue or the new entry already sets its own.
  const nextEntry: DeferredObjectiveSettingsEntry = rescuePolicy === 'preserve'
    && params.entry.rescue === undefined
    && prevEntry?.rescue !== undefined
    ? { ...params.entry, rescue: prevEntry.rescue }
    : params.entry;

  writeObjectiveForDevice(deps.store, deviceId, nextEntry);
  notifyAndRebuild(deps, { deviceId, deviceName, prevEntry, nextEntry, nowMs: deps.nowMs });
  return { persisted: true };
};

/**
 * Clear a device's deferred objective.
 *
 * Returns the same `ObjectiveWriteOutcome` as the write primitives. Two distinct
 * `persisted: true` outcomes collapse into one: the key was unset, OR it was a
 * genuine trustworthy-absent no-op (nothing to clear). Both leave the user's
 * intent satisfied, so both report success. Only the un-confirmable migration
 * guard is a retryable refusal.
 */
export const clearObjectiveForDevice = (
  deps: DeferredObjectiveDeviceWriteDeps,
  params: { deviceId: string; deviceName: string | null },
): ObjectiveWriteOutcome => {
  if (!ensureMigrated(deps)) return refuse(deps, 'clear', params.deviceId, 'migration_deferred');
  const { deviceId, deviceName } = params;
  // Skip ONLY when the absence is TRUSTWORTHY (key list readable AND key absent) —
  // a genuine no-op worth avoiding the plan rebuild for. A present key OR a
  // store-wide empty `getKeys()` flake both fall through to the (idempotent) unset,
  // so a transient/malformed read can't make the clear silently no-op while the
  // objective stays persisted and reappears on the next clean cycle.
  if (objectiveAbsenceIsTrustworthy(deps.store, deviceId)) return { persisted: true };
  const prevEntry = readObjectiveForDevice(deps.store, deviceId);
  clearObjectiveKey(deps.store, deviceId);
  notifyAndRebuild(deps, { deviceId, deviceName, prevEntry, nextEntry: undefined, nowMs: deps.nowMs });
  return { persisted: true };
};
