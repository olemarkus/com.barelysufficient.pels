import { handleWidgetClientLog, type WidgetClientLogContext } from '../../_shared/widgetClientLogApi';
import {
  buildValidSmartTaskCandidate,
  mapSmartTaskAppReason,
  parseSmartTaskCandidateRequest,
  resolveSmartTaskRequestDeadline,
  resolveSmartTaskWriteDeadline,
} from '../../../lib/objectives/deferredObjectives';
import type { CreateSmartTaskHostApi } from '../../../packages/contracts/src/widgetHostApi';
import {
  formatScheduledHoursWindow,
  formatSmartTaskDeadlineLong,
} from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { buildCreateSmartTaskDevicesPayload } from './createSmartTaskWidgetPayload';
import type {
  CreateSmartTaskCreateResponse,
  CreateSmartTaskDevicesPayload,
  CreateSmartTaskPreviewResponse,
  CreateSmartTaskRejectReason,
} from './createSmartTaskWidgetTypes';

// The widget API runs in the app process. The candidate parsing, the
// server-side "Ready by" (HH:mm local) → absolute `deadlineAtMs` conversion
// (DST-aware, against the Homey timezone), and the candidate validation are the
// shared smart-task request helpers (`lib/objectives/deferredObjectives/
// smartTaskCandidateRequest.ts`) — the same lane the settings-UI edit endpoints
// use. The app methods it forwards to (`previewDeferredObjectivePlan`,
// `createDeferredObjective`) are the single source of truth for projection and
// persistence.

type WidgetApiContext = {
  homey: {
    app?: CreateSmartTaskHostApi;
    clock?: { getTimezone?: () => string };
  };
};

type WidgetApiBody = { body?: unknown };

const readTimeZone = (homey: WidgetApiContext['homey']): string => {
  const tz = homey.clock?.getTimezone?.();
  return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
};

const previewReject = (reason: CreateSmartTaskRejectReason): CreateSmartTaskPreviewResponse => ({
  ok: false,
  reason,
});

const createReject = (reason: CreateSmartTaskRejectReason): CreateSmartTaskCreateResponse => ({
  ok: false,
  reason,
});

const rejectForHomeScope = (
  scope: ReturnType<CreateSmartTaskHostApi['resolveSmartTaskHomeScope']>,
): 'device_in_sub_home' | 'device_not_planned' | 'unavailable' | null => {
  if (scope === 'sub_home') return 'device_in_sub_home';
  if (scope === 'source_device') return 'device_not_planned';
  if (scope === 'unavailable') return 'unavailable';
  return null;
};

export const getCreateSmartTaskDevices = async (
  { homey }: WidgetApiContext,
): Promise<CreateSmartTaskDevicesPayload> => {
  if (typeof homey.app?.getCreateSmartTaskCandidateDevices !== 'function') {
    return { state: 'error' };
  }
  const read = homey.app.getCreateSmartTaskCandidateDevices();
  if (read.state === 'unavailable') return { state: 'error' };
  return buildCreateSmartTaskDevicesPayload({ devices: read.devices });
};

export const previewCreateSmartTask = async (
  { homey, body }: WidgetApiContext & WidgetApiBody,
): Promise<CreateSmartTaskPreviewResponse> => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return previewReject('invalid_request');
  // Call the app method on `homey.app` (not via an extracted const): the method
  // relies on its `this` (`this.latestTargetSnapshot`, `this.getUiPickerDevices()`,
  // …), so a detached reference would throw a runtime TypeError.
  if (typeof homey.app?.previewDeferredObjectivePlan !== 'function') return previewReject('unavailable');
  if (typeof homey.app.resolveSmartTaskHomeScope !== 'function') return previewReject('unavailable');
  const scopeReject = rejectForHomeScope(homey.app.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return previewReject(scopeReject);

  const timeZone = readTimeZone(homey);
  const nowMs = Date.now();
  const deadlineAtMs = resolveSmartTaskRequestDeadline(request, timeZone, nowMs);
  if (deadlineAtMs === null) return previewReject('invalid_ready_by');

  const candidate = buildValidSmartTaskCandidate(request, deadlineAtMs);
  if (!candidate) return previewReject('invalid_candidate');
  const estimate = homey.app.previewDeferredObjectivePlan(request.deviceId, candidate);
  return {
    ok: true,
    deadlineAtMs,
    deadlineLabel: formatSmartTaskDeadlineLong(deadlineAtMs, nowMs, timeZone),
    // Format the scheduled-hours window server-side in the Homey timezone so it
    // agrees with deadlineLabel; the widget displays it verbatim (no client TZ math).
    scheduledWindowLabel: formatScheduledHoursWindow(estimate.scheduledHours, timeZone),
    estimate,
  };
};

export const createCreateSmartTask = async (
  { homey, body }: WidgetApiContext & WidgetApiBody,
): Promise<CreateSmartTaskCreateResponse> => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return createReject('invalid_request');
  // Call on `homey.app` directly to preserve `this` — `createDeferredObjective`
  // reads `this.latestTargetSnapshot` / `this.homey.settings`, so a detached
  // reference would throw a runtime TypeError.
  if (typeof homey.app?.createDeferredObjective !== 'function') return createReject('unavailable');
  if (typeof homey.app.resolveSmartTaskHomeScope !== 'function') return createReject('unavailable');
  // Re-check scope on the create request, not only during preview: the device
  // may have moved or global ownership may have become provisional while the
  // user was composing the task.
  const scopeReject = rejectForHomeScope(homey.app.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return createReject(scopeReject);

  const timeZone = readTimeZone(homey);
  const nowMs = Date.now();
  const deadline = resolveSmartTaskWriteDeadline(request, timeZone, nowMs);
  if (!deadline.ok) return createReject(deadline.reason);

  const candidate = buildValidSmartTaskCandidate(request, deadline.deadlineAtMs);
  if (!candidate) return createReject('invalid_candidate');
  const result = homey.app.createDeferredObjective(request.deviceId, candidate);
  if (result.ok) return { ok: true };
  return createReject(mapSmartTaskAppReason(result.reason));
};

export const logClientError = (context: WidgetClientLogContext): { ok: boolean } => (
  handleWidgetClientLog('create_smart_task', context)
);
