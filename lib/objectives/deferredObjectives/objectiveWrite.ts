import type { TaskEvaluation } from './taskEvaluation';
import { applyDeferredObjectiveChange } from './objectiveChange';
import type { DeferredObjectiveChangeInput } from './objectiveChange';
import type { DeferredObjectiveActivePlanRecorder } from './activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from './planHistory';
import {
  clearObjectiveForDevice as clearObjectiveKey,
  objectiveAbsenceIsTrustworthy,
  readObjectiveForDevice,
  writeObjectiveForDevice,
  type ObjectiveSettingsStore,
} from './objectiveStore';
import type { DeferredObjectiveSettingsEntry } from '../../../packages/contracts/src/deferredObjectiveSettings';
import { isSmartTaskOpen } from '../../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { getDebugEmitter } from '../../logging/logger';
import type { SmartTaskHomeScope } from '../../../packages/contracts/src/smartTaskHomeScope';
import type { CurrentTaskEvaluationReader } from './currentTaskEvaluation';

// ─── Device-scoped operations (per-device-key storage) ───────────────────────
//
// Each device's objective is persisted under its OWN settings key (see
// `objectiveStore.ts`). Callers express device-level intent ("set this device's
// objective", "clear this device's objective"); they never touch a shared map.
// Because a per-key `set`/`unset` cannot drop a sibling device's entry, the
// whole-map clobber class is structurally dissolved — there is no
// read-modify-write to guard, so these ops cannot fail-as-clobber and have no
// refusal branch.

// The outcome of a device-scoped write. A write either PERSISTED, or REFUSED.
// Two refusal reasons are retryable (an absence the key list cannot confirm —
// see the guard below — or an unavailable home-scope read); both map to the
// same user-facing "couldn't save just now, retry" framing.
// `device_in_sub_home` and `device_not_planned` are hard scope rejections, NOT
// retryable: smart tasks are planned against the MAIN home's meter budget, and
// an active meter source is never a planned load. Callers surface these as
// durable device-scope outcomes, never transient write failures. The old
// `void` return hid refusals, so callers reported success while nothing was
// written.
export type ObjectiveWriteOutcome =
  | { persisted: true }
  | {
    persisted: false;
    reason: 'untrusted_absence' | 'device_in_sub_home' | 'device_not_planned' | 'ownership_unavailable';
  };

/** `createObjectiveForDevice`'s outcome: an upsert's, plus the open-task refusal. */
export type CreateObjectiveWriteOutcome =
  | ObjectiveWriteOutcome
  | { persisted: false; reason: 'open_task_exists' };

export type DeferredObjectiveDeviceWriteDeps = {
  store: ObjectiveSettingsStore;
  planHistoryRecorder: DeferredObjectivePlanHistoryRecorder;
  activePlanRecorder: DeferredObjectiveActivePlanRecorder;
  nowMs: number;
  readCurrentTaskEvaluation: CurrentTaskEvaluationReader;
  // Main-home scope gate, wired by `buildDeferredObjectiveDeviceWriteDeps`
  // from the membership service. A separate-meter sub-home refuses as
  // `device_in_sub_home`; an active meter source refuses as
  // `device_not_planned`. Every write lane (widget create, settings-UI edit,
  // Flow cards, rescue) funnels through these deps, so this is the
  // defence-in-depth chokepoint.
  // Optional: an absent resolver in bare test harnesses preserves the legacy
  // pass-through behavior.
  // Clearing is deliberately NOT gated — a user must always be able to clear a
  // task whose device was later moved to a sub-home.
  resolveDeviceHomeScope?: (deviceId: string) => SmartTaskHomeScope;
};

/** Capture against the old settings before a write can replace its obligation. */
const readPreviousEvaluation = (
  deps: DeferredObjectiveDeviceWriteDeps,
  deviceId: string,
  objective: DeferredObjectiveSettingsEntry | undefined,
): TaskEvaluation | undefined => {
  if (objective === undefined || !objective.enabled || objective.deadlineAtMs <= deps.nowMs) return undefined;
  return deps.readCurrentTaskEvaluation(deviceId, objective);
};

const emitObjectiveDebug = getDebugEmitter('deferred_objectives', 'deferred_objectives');

// Emit a topic-gated debug breadcrumb for a refused write and return the
// outcome. A refusal is a self-healing transient (the guards leave persisted
// state intact and the caller surfaces a retry), so it is a diagnostic payload
// — the `deferred_objectives` debug topic (info/error go through `getLogger`;
// structured debug goes here) is the right sink, NOT an error-sink log.
// Without this, a transient refusal was visible only as the user-facing card
// error and left no server-side trace to correlate against.
const refuse = (
  deviceId: string,
  reason: 'untrusted_absence' | 'device_in_sub_home' | 'device_not_planned' | 'ownership_unavailable',
): ObjectiveWriteOutcome => {
  emitObjectiveDebug({ event: 'objective_write_refused', deviceId, reason });
  return { persisted: false, reason };
};

// Notify both recorders and flush them. This is the single chokepoint every
// objective write funnels through so the active-plan hero and the plan-history
// audit trail stay consistent — there is no parallel notify/flush sequence to
// drift from. The planner reads the new objective at the next power reading that
// rebuilds; the write itself requests no rebuild.
const notifyAndFlush = (
  deps: DeferredObjectiveDeviceWriteDeps,
  change: DeferredObjectiveChangeInput,
): void => {
  applyDeferredObjectiveChange(change, deps.planHistoryRecorder, deps.activePlanRecorder);
  deps.activePlanRecorder.flushIfDirty();
  deps.planHistoryRecorder.flushIfDirty();
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
  deviceId: string,
  deviceName: string | null,
  entry: DeferredObjectiveSettingsEntry,
  rescue: 'preserve' | 'replace' = 'preserve',
): ObjectiveWriteOutcome => writeObjective(deps, deviceId, deviceName, entry, rescue, 'replace');

/**
 * Create a device's deferred objective, refusing while the device has an OPEN
 * one (`isSmartTaskOpen`): a create surface offers that task instead of
 * replacing it. The refusal is decided against the same trusted read of the
 * previous entry the write itself uses, so no gap between a separate check and
 * the write can let a create land over a task it did not see.
 */
export const createObjectiveForDevice = (
  deps: DeferredObjectiveDeviceWriteDeps,
  deviceId: string,
  deviceName: string | null,
  entry: DeferredObjectiveSettingsEntry,
  rescue: 'preserve' | 'replace',
): CreateObjectiveWriteOutcome => writeObjective(deps, deviceId, deviceName, entry, rescue, 'refuse');

const refuseForHomeScope = (
  deps: DeferredObjectiveDeviceWriteDeps,
  deviceId: string,
): ObjectiveWriteOutcome | null => {
  const homeScope = deps.resolveDeviceHomeScope?.(deviceId) ?? 'main';
  if (homeScope === 'sub_home') return refuse(deviceId, 'device_in_sub_home');
  if (homeScope === 'source_device') return refuse(deviceId, 'device_not_planned');
  if (homeScope === 'unavailable') return refuse(deviceId, 'ownership_unavailable');
  return null;
};

type RescuePolicy = 'preserve' | 'replace';

// One body for both writes; only `'refuse'` can answer `open_task_exists`, and
// the overloads say so, so an upsert's outcome never carries it.
function writeObjective(
  deps: DeferredObjectiveDeviceWriteDeps, deviceId: string, deviceName: string | null,
  entry: DeferredObjectiveSettingsEntry, rescuePolicy: RescuePolicy, openTask: 'replace',
): ObjectiveWriteOutcome;
function writeObjective(
  deps: DeferredObjectiveDeviceWriteDeps, deviceId: string, deviceName: string | null,
  entry: DeferredObjectiveSettingsEntry, rescuePolicy: RescuePolicy, openTask: 'refuse',
): CreateObjectiveWriteOutcome;
function writeObjective(
  deps: DeferredObjectiveDeviceWriteDeps,
  deviceId: string,
  deviceName: string | null,
  entry: DeferredObjectiveSettingsEntry,
  rescuePolicy: RescuePolicy,
  openTask: 'replace' | 'refuse',
): CreateObjectiveWriteOutcome {
  // v1 scope gate FIRST: a sub-home device's rejection is a hard, honest "not
  // available here", never the transient retry framing the guards below map to.
  // See the dep's doc — clear (`clearObjectiveForDevice`) is intentionally
  // ungated so a task on a relocated device can always be removed.
  const scopeRefusal = refuseForHomeScope(deps, deviceId);
  if (scopeRefusal !== null) return scopeRefusal;
  const prevEntry = readObjectiveForDevice(deps.store, deviceId);
  // Unreadable-read guard: only proceed as a genuine create when the absence is
  // TRUSTWORTHY (key list readable AND key absent). A listed key whose value does
  // not read back, or a key list that cannot be read, means "can't trust this is
  // objective-less", so refuse rather than overwrite the user's objective / drop
  // a preserved rescue.
  if (prevEntry === undefined && !objectiveAbsenceIsTrustworthy(deps.store, deviceId)) {
    return refuse(deviceId, 'untrusted_absence');
  }
  if (openTask === 'refuse' && prevEntry !== undefined && isSmartTaskOpen(prevEntry, deps.nowMs)) {
    emitObjectiveDebug({ event: 'objective_write_refused', deviceId, reason: 'open_task_exists' });
    return { persisted: false, reason: 'open_task_exists' };
  }
  // Preserve a standing rescue permission unless the caller is authoritative
  // about rescue or the new entry already sets its own.
  const nextEntry: DeferredObjectiveSettingsEntry = rescuePolicy === 'preserve'
    && entry.rescue === undefined
    && prevEntry?.rescue !== undefined
    ? { ...entry, rescue: prevEntry.rescue }
    : entry;

  const previousEvaluation = readPreviousEvaluation(deps, deviceId, prevEntry);
  writeObjectiveForDevice(deps.store, deviceId, nextEntry);
  notifyAndFlush(deps, { deviceId, deviceName, prevEntry, nextEntry, nowMs: deps.nowMs, previousEvaluation });
  return { persisted: true };
}

/**
 * Clear a device's deferred objective. A clear never refuses: the key is
 * unset, or a trustworthy absence means there was nothing to clear. Both leave
 * the user's intent satisfied.
 */
export const clearObjectiveForDevice = (
  deps: DeferredObjectiveDeviceWriteDeps,
  params: { deviceId: string; deviceName: string | null },
): void => {
  const { deviceId, deviceName } = params;
  // Skip ONLY when the absence is TRUSTWORTHY (key list readable AND key absent) —
  // a genuine no-op worth skipping the notify for. A listed key OR a key list
  // that cannot be read falls through to the (idempotent) unset, so an
  // unreadable read can't make the clear silently no-op while the objective
  // stays persisted.
  if (objectiveAbsenceIsTrustworthy(deps.store, deviceId)) return;
  const prevEntry = readObjectiveForDevice(deps.store, deviceId);
  const previousEvaluation = readPreviousEvaluation(deps, deviceId, prevEntry);
  clearObjectiveKey(deps.store, deviceId);
  notifyAndFlush(deps, {
    deviceId, deviceName, prevEntry, nextEntry: undefined, nowMs: deps.nowMs, previousEvaluation,
  });
};
