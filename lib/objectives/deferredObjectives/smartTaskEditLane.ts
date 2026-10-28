import type { DeferredObjectiveSettingsEntry } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type {
  SettingsUiSmartTaskCancelResponse,
  SettingsUiSmartTaskPreviewResponse,
  SettingsUiSmartTaskRejectReason,
  SettingsUiSmartTaskUpdateResponse,
} from '../../../packages/contracts/src/smartTaskEdit';
import type { CreateSmartTaskHostApi } from '../../../packages/contracts/src/widgetHostApi';
import {
  formatScheduledHoursWindow,
  formatSmartTaskDeadlineLong,
} from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import {
  objectiveAbsenceIsTrustworthy,
  readObjectiveForDevice,
  type ObjectiveSettingsStore,
} from './objectiveStore';
import {
  buildValidSmartTaskCandidate,
  mapSmartTaskAppReason,
  parseSmartTaskCandidateRequest,
  resolveSmartTaskRequestDeadline,
  resolveSmartTaskWriteDeadline,
} from './smartTaskCandidateRequest';
import { rejectForSmartTaskHomeScope } from './smartTaskCreateLane';

// The settings UI's edit lane (the task's detail page: edit end time/target,
// and clear). Editing routes through the SAME validated app method the
// create_smart_task widget uses (`createDeferredObjective` →
// `upsertObjectiveForDevice`), so an edit is a full re-create: the prior run is
// finalized to history as replaced, the run's `startedAtMs` baseline survives,
// and a candidate without extra permissions preserves any standing rescue
// permission. The lane's own addition is the task-must-exist guard: an
// edit/clear against a device whose task just ended answers `task_not_found`
// instead of silently creating a fresh task. `setup/` binds the ports and
// forwards.

/** The app as the edit lane uses it. Called as methods: they rely on `this`. */
export type SmartTaskEditLaneHost = Pick<
  CreateSmartTaskHostApi,
  'resolveSmartTaskHomeScope' | 'previewDeferredObjectivePlan' | 'createDeferredObjective'
> & {
  cancelDeferredObjective(deviceId: string): SettingsUiSmartTaskCancelResponse;
};

/**
 * What the lane reads and calls: the app (`null` while it is not wired, during
 * the boot window), the stored tasks, and the Homey clock.
 */
export type SmartTaskEditLanePorts = {
  host: SmartTaskEditLaneHost | null;
  store: ObjectiveSettingsStore;
  clock: { getTimezone(): string };
};

const previewReject = (reason: SettingsUiSmartTaskRejectReason): SettingsUiSmartTaskPreviewResponse => ({
  ok: false,
  reason,
});

const updateReject = (reason: SettingsUiSmartTaskRejectReason): SettingsUiSmartTaskUpdateResponse => ({
  ok: false,
  reason,
});

// The edit lane only ever REVISES an existing task, and the two reject lanes
// are deliberately distinct:
//
// - `task_not_found` only on a TRUSTWORTHY absence (readable key list, key
//   missing) or a stored entry that is disabled or already past its deadline.
//   Disabled entries are not editable because the candidate always persists
//   as `enabled: true` — an edit of a paused task would silently un-pause it.
//   Expired-but-not-yet-disabled entries (the window before the lifecycle
//   pass flips them) are not editable either: a "revision" there would
//   finalize the already-ended run as replaced instead of letting it record
//   as completed/missed, silently extending a task that just ended.
// - A transient-empty/flaky read (`getKeys()` empty — the same flake the
//   store's write guards refuse on) maps to the retryable `write_conflict`
//   lane instead: one flaky read must never make the UI discard an open
//   draft and declare a still-live task "ended"
//   (`feedback_homey_sdk_unreliable`). A read that throws is the same unknown.
const gateEditableTask = (
  store: ObjectiveSettingsStore,
  deviceId: string,
): { editable: true; entry: DeferredObjectiveSettingsEntry }
  | { editable: false; reason: 'task_not_found' | 'write_conflict' } => {
  try {
    const entry = readObjectiveForDevice(store, deviceId);
    if (entry !== undefined) {
      return entry.enabled && entry.deadlineAtMs > Date.now()
        ? { editable: true, entry }
        : { editable: false, reason: 'task_not_found' };
    }
    return {
      editable: false,
      reason: objectiveAbsenceIsTrustworthy(store, deviceId) ? 'task_not_found' : 'write_conflict',
    };
  } catch {
    return { editable: false, reason: 'write_conflict' };
  }
};

/** Preview an edit of the device's open task. Read-only. */
export const previewSmartTaskEdit = (
  ports: SmartTaskEditLanePorts,
  body: unknown,
): SettingsUiSmartTaskPreviewResponse => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return previewReject('invalid_request');
  const { host } = ports;
  if (!host) return previewReject('unavailable');
  const gate = gateEditableTask(ports.store, request.deviceId);
  if (!gate.editable) return previewReject(gate.reason);
  const scopeReject = rejectForSmartTaskHomeScope(host.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return previewReject(scopeReject);

  const timeZone = ports.clock.getTimezone();
  const nowMs = Date.now();
  // The preview always re-resolves the ready-by time fresh (never trusts an
  // echoed deadline) — it is the step that PRODUCES the deadline the update
  // later echoes back.
  const deadlineAtMs = resolveSmartTaskRequestDeadline(request, timeZone, nowMs);
  if (deadlineAtMs === null) return previewReject('invalid_ready_by');

  // Preview ≡ persist BY CONSTRUCTION: this builds the same candidate the save
  // builds, from the same request and the same standing permissions, so the
  // estimate is priced under exactly the rescue the write will persist —
  // including a permission the user just switched off, which tightens the plan.
  // (Merging the standing set over the requested one here, as an earlier shape
  // did, made the two disagree the moment a toggle changed.)
  const candidate = buildValidSmartTaskCandidate(request, deadlineAtMs, gate.entry.rescue);
  if (!candidate) return previewReject('invalid_candidate');
  const estimate = host.previewDeferredObjectivePlan(request.deviceId, candidate);
  return {
    ok: true,
    deadlineAtMs,
    // Both labels are formatted server-side in the Homey timezone so the
    // browser does no Date math and the two can never disagree.
    deadlineLabel: formatSmartTaskDeadlineLong(deadlineAtMs, nowMs, timeZone),
    scheduledWindowLabel: formatScheduledHoursWindow(estimate.scheduledHours, timeZone),
    estimate,
  };
};

/**
 * Save an edit of the device's open task. Requires that task to still be
 * open, and keeps every permission the request does not mention.
 */
export const updateSmartTask = (
  ports: SmartTaskEditLanePorts,
  body: unknown,
): SettingsUiSmartTaskUpdateResponse => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return updateReject('invalid_request');
  const { host } = ports;
  if (!host) return updateReject('unavailable');
  const gate = gateEditableTask(ports.store, request.deviceId);
  if (!gate.editable) return updateReject(gate.reason);
  const scopeReject = rejectForSmartTaskHomeScope(host.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return updateReject(scopeReject);

  const timeZone = ports.clock.getTimezone();
  const nowMs = Date.now();
  // Persist the EXACT deadline the preview showed (echoed back) after
  // re-validating it is still future and within the sane horizon; without a
  // preview step, re-resolve the ready-by time server-side.
  const deadline = resolveSmartTaskWriteDeadline(request, timeZone, nowMs);
  if (!deadline.ok) return updateReject(deadline.reason);

  // The candidate carries the COMPLETE desired permission set: the builder
  // merges the request over the task's standing permissions per key, so an
  // unmentioned one survives, a `true` keeps its existing mode rather than being
  // upgraded to `'always'`, and a `false` revokes.
  const candidate = buildValidSmartTaskCandidate(request, deadline.deadlineAtMs, gate.entry.rescue);
  if (!candidate) return updateReject('invalid_candidate');
  // A revision keeps the run's trusted origin; request bodies cannot supply one.
  const candidateWithSource = gate.entry.scheduleSource
    ? { ...candidate, scheduleSource: gate.entry.scheduleSource }
    : candidate;
  // `'replace'` because that merge already happened here. The write layer's
  // `'preserve'` is a WHOLE-OBJECT fallback — it only fires when the entry
  // carries no rescue at all — so leaving it on would drop every standing
  // permission the moment the request granted any one of them.
  const result = host.createDeferredObjective(
    request.deviceId,
    candidateWithSource,
    'replace',
  );
  if (result.ok) return { ok: true };
  return updateReject(mapSmartTaskAppReason(result.reason));
};

/** Clear the device's task. */
export const cancelSmartTask = (
  ports: SmartTaskEditLanePorts,
  body: unknown,
): SettingsUiSmartTaskCancelResponse => {
  const deviceId = body && typeof body === 'object' && !Array.isArray(body)
    && typeof (body as { deviceId?: unknown }).deviceId === 'string'
    ? (body as { deviceId: string }).deviceId.trim()
    : '';
  if (!deviceId) return { ok: false, reason: 'invalid_request' };
  if (!ports.host) return { ok: false, reason: 'unavailable' };
  return ports.host.cancelDeferredObjective(deviceId);
};
