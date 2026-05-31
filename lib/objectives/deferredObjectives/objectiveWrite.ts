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

// The outcome of a device-scoped write. A write either PERSISTED, or REFUSED a
// retryable transient condition (an un-confirmable per-key migration, or an
// untrustworthy absence read — see the guards below). The two refusal reasons
// are kept distinct so callers can log/diagnose, but both map to the same
// user-facing "couldn't save just now, retry" framing. The old `void` return
// hid these refusals, so callers reported success while nothing was written.
export type ObjectiveWriteOutcome =
  | { persisted: true }
  | { persisted: false; reason: 'migration_deferred' | 'untrusted_absence' };

export type DeferredObjectiveDeviceWriteDeps = {
  store: ObjectiveSettingsStore;
  planHistoryRecorder: DeferredObjectivePlanHistoryRecorder;
  activePlanRecorder: DeferredObjectiveActivePlanRecorder;
  rebuildPlan: () => void;
  nowMs: number;
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
  reason: 'migration_deferred' | 'untrusted_absence',
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
 * Resolve the EXACT objective entry the budget-exempt rescue will persist for a
 * device, given the device's existing objective (if any) and the rescue entry
 * the caller built for the no-objective case.
 *
 * This is the single source of truth for the rescue merge outcome. Both the
 * write path (`addBudgetExemptionRescueForDevice`) and the rescue PREVIEW path
 * (the widget's preview handler) derive `(target, deadline, rescue)` from here,
 * so the plan/cost the user confirms can never diverge from what is persisted:
 *
 * - When the device ALREADY has an objective, only `rescue.exemptFromBudget:
 *   'always'` is added to it and `enabled: true` is ensured. Its target,
 *   deadline, enforcement, and any OTHER rescue permission are preserved
 *   verbatim. An existing `exemptFromBudget: 'at_risk'` is PROMOTED to
 *   `'always'` (the user explicitly asked for power now on an already-starved
 *   device — there is no "wait until at risk" left to defer to).
 * - When the device has NO objective, the caller-built `rescueEntry` (the
 *   device's intended normal target, a near-term deadline, and
 *   `rescue.exemptFromBudget: 'always'`) is used as-is.
 */
export const resolveBudgetExemptionRescueEntry = (
  prevEntry: DeferredObjectiveSettingsEntry | undefined,
  rescueEntry: DeferredObjectiveSettingsEntry,
): DeferredObjectiveSettingsEntry => (
  prevEntry === undefined
    ? rescueEntry
    : { ...prevEntry, enabled: true, rescue: { ...prevEntry.rescue, exemptFromBudget: 'always' } }
);

/**
 * Grant a device a budget-exempt rescue (the starvation-rescue widget's lane),
 * with MERGE-not-replace semantics:
 *
 * - When the device ALREADY has an objective, only `rescue.exemptFromBudget:
 *   'always'` is added to it (and `enabled: true` is ensured — see below). Its
 *   target, deadline, enforcement, and any OTHER rescue permission (e.g. a
 *   standing `limitLowerPriorityDevices`) are preserved verbatim — the rescue
 *   grants a budget exemption, it does not overwrite the user's objective. Note
 *   this unconditionally sets `exemptFromBudget: 'always'`, so an existing
 *   `exemptFromBudget: 'at_risk'` is PROMOTED to `'always'` (the user explicitly
 *   asked for power now on an already-starved device — there is no "wait until at
 *   risk" left to defer to). A
 *   device already carrying the exemption AND enabled is a no-op write (the same
 *   entry), so the run is not finalized/re-seeded.
 *
 *   `enabled: true` is forced because the budget exemption is ignored by the
 *   planner on a DISABLED objective (`concurrentEligibleTasks`: `if
 *   (!objective.enabled) return false` runs before the exemption check). Merging
 *   the exemption into a disabled task while leaving it disabled would silently
 *   no-op the whole rescue — the user explicitly asked for power now, so the
 *   objective must be live. Re-enabling a previously-disabled task is treated as
 *   the START of a run (a pending active plan is seeded), which is correct.
 * - When the device has NO objective, `rescueEntry` (built by the caller: the
 *   device's intended normal target, a near-term deadline, and
 *   `rescue.exemptFromBudget: 'always'`) is created.
 *
 * Routes through the SAME per-key write + notify/rebuild chokepoint as
 * `upsertObjectiveForDevice`, so recorder consistency is identical.
 */
export const addBudgetExemptionRescueForDevice = (
  deps: DeferredObjectiveDeviceWriteDeps,
  params: {
    deviceId: string;
    deviceName: string | null;
    // The rescue objective to CREATE when the device has no existing objective.
    // Ignored (except for kind/target/deadline validation done by the caller)
    // when an objective already exists — that path only adds the exemption.
    rescueEntry: DeferredObjectiveSettingsEntry;
  },
): ObjectiveWriteOutcome => {
  if (!ensureMigrated(deps)) return refuse(deps, 'rescue', params.deviceId, 'migration_deferred');
  const { deviceId, deviceName } = params;
  const prevEntry = readObjectiveForDevice(deps.store, deviceId);
  // Flaky-read guard: only CREATE a fresh rescue when the absence is TRUSTWORTHY
  // (key list readable AND key absent). A present-but-unreadable key OR a
  // store-wide empty `getKeys()` would otherwise make the merge take the
  // no-objective branch and OVERWRITE the user's objective (target/deadline) with
  // a fresh rescue — refuse instead; the rescue retries on a clean read.
  if (prevEntry === undefined && !objectiveAbsenceIsTrustworthy(deps.store, deviceId)) {
    return refuse(deps, 'rescue', deviceId, 'untrusted_absence');
  }
  // Single source of truth for the merge outcome, shared with the preview path
  // so preview ≡ persist (see `resolveBudgetExemptionRescueEntry`). Preserves
  // the existing objective; ensures it is enabled (a disabled task's exemption
  // is ignored by the planner) and the budget exemption is on.
  const nextEntry = resolveBudgetExemptionRescueEntry(prevEntry, params.rescueEntry);

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
