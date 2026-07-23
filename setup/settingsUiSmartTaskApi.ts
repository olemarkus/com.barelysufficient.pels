import type Homey from 'homey';
import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
} from '../packages/contracts/src/deferredObjectivePlanPreview';
import type {
  SettingsUiSmartTaskCancelResponse,
  SettingsUiSmartTaskPreviewResponse,
  SettingsUiSmartTaskRejectReason,
  SettingsUiSmartTaskUpdateResponse,
} from '../packages/contracts/src/smartTaskEdit';
import type { WidgetObjectiveWriteResult } from '../packages/contracts/src/widgetHostApi';
import type { SmartTaskHomeScope } from '../packages/contracts/src/smartTaskHomeScope';
import {
  formatScheduledHoursWindow,
  formatSmartTaskDeadlineLong,
} from '../packages/shared-domain/src/smartTaskDeadlineFormat';
import {
  buildValidSmartTaskCandidate,
  mapSmartTaskAppReason,
  migrateBlobToPerKeyIfNeeded,
  parseSmartTaskCandidateRequest,
  readObjectiveForDevice,
  resolveSmartTaskRequestDeadline,
  resolveSmartTaskWriteDeadline,
  type SmartTaskWriteOrigin,
} from '../lib/objectives/deferredObjectives';
import type { DeferredObjectiveSettingsEntry } from '../lib/objectives/deferredObjectives/settings';
import { objectiveAbsenceIsTrustworthy } from '../lib/objectives/deferredObjectives/objectiveStore';
import type { CancelDeferredObjectiveOutcome } from './appInit/deferredObjectiveCancel';

// Settings-UI smart-task edit lane (detail-page edit + clear). Editing routes
// through the SAME validated app method the create_smart_task widget uses
// (`createDeferredObjective` → `upsertObjectiveForDevice`), so an edit is a
// full re-create: the prior run is finalized to history as replaced, the run's
// `startedAtMs` baseline survives, and a candidate without extra permissions
// preserves any standing rescue permission. The lane's own addition is the
// task-must-exist guard: an edit/clear against a device whose task just ended
// answers `task_not_found` instead of silently creating a fresh task.

type SmartTaskEditApp = Homey.App & {
  resolveSmartTaskHomeScope?: (deviceId: string) => SmartTaskHomeScope;
  previewDeferredObjectivePlan?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ) => DeferredObjectivePlanPreviewEstimate;
  createDeferredObjective?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
    origin?: SmartTaskWriteOrigin,
  ) => WidgetObjectiveWriteResult;
  cancelDeferredObjective?: (deviceId: string) => CancelDeferredObjectiveOutcome;
};

type ApiContext = {
  homey: Homey.App['homey'];
};

const getApp = (homey: Homey.App['homey']): SmartTaskEditApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as SmartTaskEditApp;
};

const previewReject = (reason: SettingsUiSmartTaskRejectReason): SettingsUiSmartTaskPreviewResponse => ({
  ok: false,
  reason,
});

const updateReject = (reason: SettingsUiSmartTaskRejectReason): SettingsUiSmartTaskUpdateResponse => ({
  ok: false,
  reason,
});

const rejectForHomeScope = (
  scope: SmartTaskHomeScope,
): 'device_in_sub_home' | 'unavailable' | null => {
  if (scope === 'sub_home') return 'device_in_sub_home';
  if (scope === 'unavailable') return 'unavailable';
  return null;
};

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
//   (`feedback_homey_sdk_unreliable`).
//
// Runs the same migrate-first guard as the other objective-write lanes so a
// legacy-blob task is not misread as absent.
const gateEditableTask = (
  homey: Homey.App['homey'],
  deviceId: string,
): { editable: true; entry: DeferredObjectiveSettingsEntry }
  | { editable: false; reason: 'task_not_found' | 'write_conflict' } => {
  migrateBlobToPerKeyIfNeeded(homey.settings);
  const entry = readObjectiveForDevice(homey.settings, deviceId);
  if (entry !== undefined) {
    return entry.enabled && entry.deadlineAtMs > Date.now()
      ? { editable: true, entry }
      : { editable: false, reason: 'task_not_found' };
  }
  return {
    editable: false,
    reason: objectiveAbsenceIsTrustworthy(homey.settings, deviceId) ? 'task_not_found' : 'write_conflict',
  };
};

export const previewSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskPreviewResponse => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return previewReject('invalid_request');
  const app = getApp(homey);
  // Call app methods on `homey.app` (not via an extracted const): they rely on
  // their `this` (`this.latestTargetSnapshot`, …).
  if (typeof app?.previewDeferredObjectivePlan !== 'function') return previewReject('unavailable');
  const gate = gateEditableTask(homey, request.deviceId);
  if (!gate.editable) return previewReject(gate.reason);
  if (typeof app.resolveSmartTaskHomeScope !== 'function') return previewReject('unavailable');
  const scopeReject = rejectForHomeScope(app.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return previewReject(scopeReject);

  const timeZone = homey.clock.getTimezone();
  const nowMs = Date.now();
  // The preview always re-resolves the ready-by time fresh (never trusts an
  // echoed deadline) — it is the step that PRODUCES the deadline the update
  // later echoes back.
  const deadlineAtMs = resolveSmartTaskRequestDeadline(request, timeZone, nowMs);
  if (deadlineAtMs === null) return previewReject('invalid_ready_by');

  const bareCandidate = buildValidSmartTaskCandidate(request, deadlineAtMs);
  if (!bareCandidate) return previewReject('invalid_candidate');
  // The preview must estimate what a save would ACTUALLY persist: the save
  // sends a rescue-less candidate and `upsertObjectiveForDevice`'s `preserve`
  // default keeps the task's standing rescue permissions (budget exemption /
  // limit-lower-priority). Estimating the bare candidate would price the
  // draft under stricter constraints than the persisted task will run with.
  const candidate = gate.entry.rescue
    ? { ...bareCandidate, rescue: gate.entry.rescue }
    : bareCandidate;
  const estimate = app.previewDeferredObjectivePlan(request.deviceId, candidate);
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

export const updateSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskUpdateResponse => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return updateReject('invalid_request');
  const app = getApp(homey);
  if (typeof app?.createDeferredObjective !== 'function') return updateReject('unavailable');
  const gate = gateEditableTask(homey, request.deviceId);
  if (!gate.editable) return updateReject(gate.reason);
  if (typeof app.resolveSmartTaskHomeScope !== 'function') return updateReject('unavailable');
  const scopeReject = rejectForHomeScope(app.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return updateReject(scopeReject);

  const timeZone = homey.clock.getTimezone();
  const nowMs = Date.now();
  // Persist the EXACT deadline the preview showed (echoed back) after
  // re-validating it is still future and within the sane horizon; without a
  // preview step, re-resolve the ready-by time server-side.
  const deadline = resolveSmartTaskWriteDeadline(request, timeZone, nowMs);
  if (!deadline.ok) return updateReject(deadline.reason);

  const candidate = buildValidSmartTaskCandidate(request, deadline.deadlineAtMs);
  if (!candidate) return updateReject('invalid_candidate');
  const result = app.createDeferredObjective(request.deviceId, candidate, 'settings_ui:smart_task_update');
  if (result.ok) return { ok: true };
  return updateReject(mapSmartTaskAppReason(result.reason));
};

export const cancelSettingsUiSmartTask = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiSmartTaskCancelResponse => {
  const deviceId = body && typeof body === 'object' && !Array.isArray(body)
    && typeof (body as { deviceId?: unknown }).deviceId === 'string'
    ? (body as { deviceId: string }).deviceId.trim()
    : '';
  if (!deviceId) return { ok: false, reason: 'invalid_request' };
  const app = getApp(homey);
  if (typeof app?.cancelDeferredObjective !== 'function') return { ok: false, reason: 'unavailable' };
  const result = app.cancelDeferredObjective(deviceId);
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason === 'task_not_found' ? 'task_not_found' : 'write_conflict' };
};
