import { applyDeferredObjectiveChange } from './objectiveChange';
import type { DeferredObjectiveChangeInput } from './objectiveChange';
import type { DeferredObjectiveActivePlanRecorder } from './activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from './planHistory';
import type { DeferredObjectiveSettingsEntry, DeferredObjectiveSettingsV1 } from './settings';

// ─── Hardened settings-mutation primitive ──────────────────────────────────
//
// This is the ONLY code that performs the read-modify-write of the
// `DEFERRED_OBJECTIVES_SETTINGS` map. Every device-scoped operation routes
// through it so there is a single place that owns the integrity guarantee.
//
// Why a guard is needed: Homey `settings.get` can transiently return
// empty/falsy/malformed on a single flaky read even when objectives are
// persisted (see notes/feedback_homey_sdk_unreliable). A device-scoped create
// is a read → merge-one-entry → write sequence; if the read came back empty on
// a bad cycle, a naive write would persist a map holding ONLY the new entry and
// silently drop every OTHER device's task. That is the P1 data-loss bug.
//
// Mitigation (mirrors the abandon-grace reconciliation in planHistory.ts /
// activePlanRecorder.ts): we never trust a single read that lost entries. We
// reconcile the read against the in-memory active-plan recorder's known-live
// objective device set, and REFUSE to persist a write that would drop a
// pre-existing entry the recorder still believes active and that the mutation
// itself did not intend to touch.

export type DeferredObjectiveSettingsMutationDeps = {
  read: () => DeferredObjectiveSettingsV1;
  write: (next: DeferredObjectiveSettingsV1) => void;
  // Device ids the in-memory active-plan recorder still believes hold a live
  // objective. Used as a second source of truth to detect a clobbering write
  // born from a transient-empty `read()`.
  knownLiveDeviceIds: () => Iterable<string>;
  // Whether the active-plan recorder's live-device set is authoritative yet.
  // It is NOT after a restart whose active-plans boot read transiently came
  // back empty/absent, until the first plan cycle re-derives the set (see
  // `DeferredObjectiveActivePlanRecorder.isLiveSetConfirmed`). While
  // unconfirmed, `knownLiveDeviceIds()` may be falsely empty, so the clobber
  // guard cannot rely on it to prove "no siblings are live". Optional so
  // existing callers/tests default to "authoritative" (the steady-state).
  liveSetAuthoritative?: () => boolean;
};

export type DeferredObjectiveSettingsMutator = (
  current: DeferredObjectiveSettingsV1,
) => {
  next: DeferredObjectiveSettingsV1;
  // The single device this mutation deliberately changes (upsert or clear).
  // Used so the clobber guard can distinguish an intentional drop of *this*
  // device's entry from an accidental loss of *other* devices' entries.
  touchedDeviceId: string;
};

// Returns the device ids present in `prev` that are NOT in `next` and were NOT
// the device the mutation intended to touch — i.e. entries that would be
// silently lost by persisting `next`.
const unintendedDrops = (
  prev: DeferredObjectiveSettingsV1,
  next: DeferredObjectiveSettingsV1,
  touchedDeviceId: string,
): string[] => Object.keys(prev.objectivesByDeviceId).filter((deviceId) => (
  deviceId !== touchedDeviceId && !(deviceId in next.objectivesByDeviceId)
));

/**
 * Apply a single-device mutation to the persisted objectives map, hardened
 * against a transient-empty/malformed `read()`.
 *
 * The mutator is applied to whatever `read()` returns. Before writing, we check
 * whether the resulting map would drop any device entry that EITHER (a) the read
 * itself still held, or (b) the in-memory recorder still believes is live —
 * other than the one device the mutation intended to touch. If it would, we
 * treat the read as untrustworthy and REFUSE the write rather than clobber other
 * devices' tasks. The caller's in-memory recorder notification still runs, so a
 * refused write does not lose the user's intent for the touched device on the
 * next clean cycle.
 *
 * Returns `true` when the write was persisted, `false` when it was refused as a
 * suspected clobber.
 */
export const mutateDeferredObjectiveSettings = (
  deps: DeferredObjectiveSettingsMutationDeps,
  mutate: DeferredObjectiveSettingsMutator,
): boolean => {
  const current = deps.read();
  const { next, touchedDeviceId } = mutate(current);

  // (a) Entries the read itself held but the write would drop.
  const dropsFromRead = unintendedDrops(current, next, touchedDeviceId);
  // (b) Entries the recorder still believes live but the write would not
  // carry — catches the case where the read came back empty (so (a) is empty)
  // yet other tasks are genuinely persisted.
  const recorderLiveIds = new Set(deps.knownLiveDeviceIds());
  const dropsFromRecorder = [...recorderLiveIds].filter((deviceId) => (
    deviceId !== touchedDeviceId && !(deviceId in next.objectivesByDeviceId)
  ));

  if (dropsFromRead.length > 0 || dropsFromRecorder.length > 0) {
    // Suspected transient-empty / malformed read: refuse to persist a map that
    // would silently lose other devices' tasks.
    return false;
  }

  // Cold-start double-empty guard. When the recorder's live set is NOT yet
  // authoritative (no plan cycle observed since boot — see
  // `DeferredObjectiveActivePlanRecorder.isLiveSetConfirmed`) AND the objectives
  // `read()` ALSO returned an empty map, both guard arms are blind: we cannot
  // prove there are no persisted siblings. ANY write that persists this empty
  // (or reduced) map in this window risks silently dropping every real objective
  // — not just creates (which would persist a map holding only the new entry),
  // but ALSO a clear/disable/no-op whose `next` is empty because the touched
  // device was absent from the bad read (`next: current`). Each of those would
  // persist an empty map and clobber siblings that exist on disk but the flaky
  // read missed. So refuse the write outright in this window. The refusal
  // self-heals once the first observe() confirms the set (callers map this to a
  // retryable conflict). Steady-state writes (post-confirmation) — including
  // legitimate clears and genuinely-empty states — are unaffected because
  // `liveSetAuthoritative` is then true.
  const liveSetAuthoritative = deps.liveSetAuthoritative?.() ?? true;
  const readWasEmpty = Object.keys(current.objectivesByDeviceId).length === 0;
  if (!liveSetAuthoritative && readWasEmpty) {
    return false;
  }

  deps.write(next);
  return true;
};

// ─── Device-scoped operations ───────────────────────────────────────────────
//
// Callers express device-level intent ("set this device's objective", "clear
// this device's objective"); they never splice the whole map. Both ops route
// the persistence through `mutateDeferredObjectiveSettings` and the recorder
// notification + plan rebuild through the shared chokepoint below, so the
// widget-create and Flow-card-create paths converge on one implementation.

export type DeferredObjectiveDeviceWriteDeps = DeferredObjectiveSettingsMutationDeps & {
  planHistoryRecorder: DeferredObjectivePlanHistoryRecorder;
  activePlanRecorder: DeferredObjectiveActivePlanRecorder;
  rebuildPlan: () => void;
  nowMs: number;
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
 *
 * Returns `false` when the hardened primitive refused the write as a suspected
 * clobber; the caller may surface this to the user. When refused, the recorder
 * notification and plan rebuild are SKIPPED — seeding a pending hero (or
 * finalizing a history run) for an objective that never reached settings would
 * only flash a phantom task the next clean plan cycle drops anyway.
 */
export const upsertObjectiveForDevice = (
  deps: DeferredObjectiveDeviceWriteDeps,
  params: {
    deviceId: string;
    deviceName: string | null;
    entry: DeferredObjectiveSettingsEntry;
    rescue?: 'preserve' | 'replace';
  },
): boolean => {
  const { deviceId, deviceName } = params;
  const rescuePolicy = params.rescue ?? 'preserve';
  let prevEntry: DeferredObjectiveSettingsEntry | undefined;
  let nextEntry: DeferredObjectiveSettingsEntry = params.entry;

  const persisted = mutateDeferredObjectiveSettings(deps, (current) => {
    prevEntry = current.objectivesByDeviceId[deviceId];
    // Preserve a standing rescue permission unless the caller is authoritative
    // about rescue or the new entry already sets its own.
    nextEntry = rescuePolicy === 'preserve'
      && params.entry.rescue === undefined
      && prevEntry?.rescue !== undefined
      ? { ...params.entry, rescue: prevEntry.rescue }
      : params.entry;
    return {
      next: {
        version: current.version,
        objectivesByDeviceId: { ...current.objectivesByDeviceId, [deviceId]: nextEntry },
      },
      touchedDeviceId: deviceId,
    };
  });

  if (persisted) {
    notifyAndRebuild(deps, { deviceId, deviceName, prevEntry, nextEntry, nowMs: deps.nowMs });
  }
  return persisted;
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
 * Routes through the SAME hardened write primitive + notify/rebuild chokepoint
 * as `upsertObjectiveForDevice`, so the clobber guard and recorder consistency
 * are identical. Returns `false` when the primitive refused the write as a
 * suspected clobber (recorder notification + rebuild skipped on refusal).
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
): boolean => {
  const { deviceId, deviceName } = params;
  let prevEntry: DeferredObjectiveSettingsEntry | undefined;
  let nextEntry: DeferredObjectiveSettingsEntry = params.rescueEntry;

  const persisted = mutateDeferredObjectiveSettings(deps, (current) => {
    prevEntry = current.objectivesByDeviceId[deviceId];
    // Single source of truth for the merge outcome, shared with the preview path
    // so preview ≡ persist (see `resolveBudgetExemptionRescueEntry`). Preserves
    // the existing objective; ensures it is enabled (a disabled task's exemption
    // is ignored by the planner) and the budget exemption is on.
    nextEntry = resolveBudgetExemptionRescueEntry(prevEntry, params.rescueEntry);
    return {
      next: {
        version: current.version,
        objectivesByDeviceId: { ...current.objectivesByDeviceId, [deviceId]: nextEntry },
      },
      touchedDeviceId: deviceId,
    };
  });

  if (persisted) {
    notifyAndRebuild(deps, { deviceId, deviceName, prevEntry, nextEntry, nowMs: deps.nowMs });
  }
  return persisted;
};

/**
 * Clear a device's deferred objective.
 *
 * Returns `false` when the hardened primitive refused the write as a suspected
 * clobber; the recorder notification + rebuild are skipped on a refusal (see
 * `upsertObjectiveForDevice`).
 */
export const clearObjectiveForDevice = (
  deps: DeferredObjectiveDeviceWriteDeps,
  params: { deviceId: string; deviceName: string | null },
): boolean => {
  const { deviceId, deviceName } = params;
  let prevEntry: DeferredObjectiveSettingsEntry | undefined;

  const persisted = mutateDeferredObjectiveSettings(deps, (current) => {
    prevEntry = current.objectivesByDeviceId[deviceId];
    if (!(deviceId in current.objectivesByDeviceId)) {
      return { next: current, touchedDeviceId: deviceId };
    }
    const { [deviceId]: _removed, ...rest } = current.objectivesByDeviceId;
    return {
      next: { version: current.version, objectivesByDeviceId: rest },
      touchedDeviceId: deviceId,
    };
  });

  if (persisted) {
    notifyAndRebuild(deps, { deviceId, deviceName, prevEntry, nextEntry: undefined, nowMs: deps.nowMs });
  }
  return persisted;
};
