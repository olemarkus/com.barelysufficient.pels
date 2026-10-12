import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type {
  NewSmartTaskWriteResult,
  SettingsUiSmartTaskPreviewResponse,
  SettingsUiSmartTaskRejectReason,
  SettingsUiSmartTaskUpdateResponse,
} from '../../../packages/contracts/src/smartTaskEdit';
import type { SmartTaskHomeScope } from '../../../packages/contracts/src/smartTaskHomeScope';
import {
  formatScheduledHoursWindow,
  formatSmartTaskDeadlineLong,
} from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { readSmartTaskOpen, type ObjectiveSettingsStore } from './objectiveStore';
import {
  buildValidSmartTaskCandidate,
  mapSmartTaskAppReason,
  parseSmartTaskCandidateRequest,
  resolveSmartTaskRequestDeadline,
  resolveSmartTaskWriteDeadline,
} from './smartTaskCandidateRequest';

// The settings UI's create lane (the Smart tasks page's New smart task and the
// device page's Add smart task): preview a new task, then create it. It owns
// the lane's decisions: a device with an open task gets no new one, a request
// is validated and resolved against the Homey timezone, and the create saves
// exactly the previewed deadline. `setup/` binds the ports and forwards.

/** The app as the create lane uses it. Called as methods: they rely on `this`. */
export type SmartTaskCreateLaneHost = {
  resolveSmartTaskHomeScope(deviceId: string): SmartTaskHomeScope;
  previewDeferredObjectivePlan(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewEstimate;
  createNewDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): NewSmartTaskWriteResult;
};

/** What the lane reads and calls: the app, the stored tasks, and the Homey clock. */
export type SmartTaskCreateLanePorts = {
  host: SmartTaskCreateLaneHost;
  store: ObjectiveSettingsStore;
  clock: { getTimezone(): string };
};

const previewReject = (reason: SettingsUiSmartTaskRejectReason): SettingsUiSmartTaskPreviewResponse => ({
  ok: false,
  reason,
});

const createReject = (reason: SettingsUiSmartTaskRejectReason): SettingsUiSmartTaskUpdateResponse => ({
  ok: false,
  reason,
});

/**
 * A device the settings UI must not plan a task for: one in a separate-meter
 * area, one selected as a meter, or one whose ownership cannot be read now.
 */
export const rejectForSmartTaskHomeScope = (
  scope: SmartTaskHomeScope,
): 'device_in_sub_home' | 'device_not_planned' | 'unavailable' | null => {
  if (scope === 'sub_home') return 'device_in_sub_home';
  if (scope === 'source_device') return 'device_not_planned';
  if (scope === 'unavailable') return 'unavailable';
  return null;
};

/**
 * Preview a new task. Read-only: refuses a device with an open task (the write
 * would), and a read that cannot tell is the retryable `write_conflict`, never
 * a preview of a create that may land over a task the read missed.
 */
export const previewNewSmartTask = (
  ports: SmartTaskCreateLanePorts,
  body: unknown,
): SettingsUiSmartTaskPreviewResponse => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return previewReject('invalid_request');
  const nowMs = Date.now();
  const open = readSmartTaskOpen(ports.store, request.deviceId, nowMs);
  if (open === 'open') return previewReject('task_exists');
  if (open === 'unavailable') return previewReject('write_conflict');
  const scopeReject = rejectForSmartTaskHomeScope(ports.host.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return previewReject(scopeReject);

  const timeZone = ports.clock.getTimezone();
  const deadlineAtMs = resolveSmartTaskRequestDeadline(request, timeZone, nowMs);
  if (deadlineAtMs === null) return previewReject('invalid_ready_by');
  const candidate = buildValidSmartTaskCandidate(request, deadlineAtMs);
  if (!candidate) return previewReject('invalid_candidate');
  const estimate = ports.host.previewDeferredObjectivePlan(request.deviceId, candidate);
  return {
    ok: true,
    deadlineAtMs,
    deadlineLabel: formatSmartTaskDeadlineLong(deadlineAtMs, nowMs, timeZone),
    scheduledWindowLabel: formatScheduledHoursWindow(estimate.scheduledHours, timeZone),
    estimate,
  };
};

/**
 * Create the previewed task. Persists the deadline the preview showed (echoed
 * back) after checking it is still ahead; the app refuses a device that has an
 * open task against its own read of the stored entry.
 */
export const createNewSmartTask = (
  ports: SmartTaskCreateLanePorts,
  body: unknown,
): SettingsUiSmartTaskUpdateResponse => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return createReject('invalid_request');
  const scopeReject = rejectForSmartTaskHomeScope(ports.host.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return createReject(scopeReject);

  const deadline = resolveSmartTaskWriteDeadline(request, ports.clock.getTimezone(), Date.now());
  if (!deadline.ok) return createReject(deadline.reason);
  const candidate = buildValidSmartTaskCandidate(request, deadline.deadlineAtMs);
  if (!candidate) return createReject('invalid_candidate');
  const result = ports.host.createNewDeferredObjective(request.deviceId, candidate);
  if (result.ok) return { ok: true };
  if (result.reason === 'task_exists') return createReject('task_exists');
  return createReject(mapSmartTaskAppReason(result.reason));
};
