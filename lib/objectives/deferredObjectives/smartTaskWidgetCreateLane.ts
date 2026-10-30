import type {
  SettingsUiSmartTaskPreviewResponse,
  SmartTaskWriteRejectReason,
} from '../../../packages/contracts/src/smartTaskEdit';
import type { CreateSmartTaskHostApi } from '../../../packages/contracts/src/widgetHostApi';
import {
  formatScheduledHoursWindow,
  formatSmartTaskDeadlineLong,
} from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import {
  buildValidSmartTaskCandidate,
  mapSmartTaskAppReason,
  parseSmartTaskCandidateRequest,
  resolveSmartTaskRequestDeadline,
  resolveSmartTaskWriteDeadline,
} from './smartTaskCandidateRequest';
import { rejectForSmartTaskHomeScope } from './smartTaskCreateLane';

// The widget create lane (the Create smart task and Device widgets): preview a
// task, then create it. Unlike the settings UI's create, it may replace the
// device's open task (`createDeferredObjective` upserts), and a permission the
// user selects is granted outright (`'always'`) over the device's standing
// set. The widget API binds the ports and forwards.

/** The app as the preview uses it; `null` while the app is not wired. Called as methods: they rely on `this`. */
export type SmartTaskWidgetPreviewHost = Pick<
  CreateSmartTaskHostApi,
  'resolveSmartTaskHomeScope' | 'previewDeferredObjectivePlan' | 'getCreateSmartTaskCandidateDevices'
>;

/** The app as the create uses it; `null` while the app is not wired. Called as methods: they rely on `this`. */
export type SmartTaskWidgetCreateHost = Pick<
  CreateSmartTaskHostApi,
  'resolveSmartTaskHomeScope' | 'createDeferredObjective' | 'getCreateSmartTaskCandidateDevices'
>;

/** What the lane reads and calls: the app and the Homey clock. */
export type SmartTaskWidgetLanePorts<Host> = {
  host: Host | null;
  clock: { getTimezone(): string };
};

export type SmartTaskWidgetPreviewResult =
  | Extract<SettingsUiSmartTaskPreviewResponse, { ok: true }>
  | { ok: false; reason: SmartTaskWriteRejectReason };

export type SmartTaskWidgetCreateResult =
  | { ok: true }
  | { ok: false; reason: SmartTaskWriteRejectReason };

const reject = (reason: SmartTaskWriteRejectReason): { ok: false; reason: SmartTaskWriteRejectReason } => ({
  ok: false,
  reason,
});

/** Preview a widget task. Read-only. */
export const previewWidgetSmartTask = (
  ports: SmartTaskWidgetLanePorts<SmartTaskWidgetPreviewHost>,
  body: unknown,
): SmartTaskWidgetPreviewResult => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return reject('invalid_request');
  const { host } = ports;
  if (!host) return reject('unavailable');
  const scopeReject = rejectForSmartTaskHomeScope(host.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return reject(scopeReject);

  const timeZone = ports.clock.getTimezone();
  const nowMs = Date.now();
  const deadlineAtMs = resolveSmartTaskRequestDeadline(request, timeZone, nowMs);
  if (deadlineAtMs === null) return reject('invalid_ready_by');

  const devices = host.getCreateSmartTaskCandidateDevices();
  if (devices.state === 'unavailable') return reject('unavailable');
  const device = devices.devices.find((entry) => entry.id === request.deviceId);
  if (!device) return reject('invalid_candidate');
  const candidate = buildValidSmartTaskCandidate(request, deadlineAtMs, device.rescue, 'always');
  if (!candidate) return reject('invalid_candidate');
  const estimate = host.previewDeferredObjectivePlan(request.deviceId, candidate);
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

/** Create a widget task, replacing an open one, with the permissions the request selects granted. */
export const createWidgetSmartTask = (
  ports: SmartTaskWidgetLanePorts<SmartTaskWidgetCreateHost>,
  body: unknown,
): SmartTaskWidgetCreateResult => {
  const request = parseSmartTaskCandidateRequest(body);
  if (!request) return reject('invalid_request');
  const { host } = ports;
  if (!host) return reject('unavailable');
  // Re-check scope on the create request, not only during preview: the device
  // may have moved or global ownership may have become provisional while the
  // user was composing the task.
  const scopeReject = rejectForSmartTaskHomeScope(host.resolveSmartTaskHomeScope(request.deviceId));
  if (scopeReject !== null) return reject(scopeReject);

  const timeZone = ports.clock.getTimezone();
  const nowMs = Date.now();
  const deadline = resolveSmartTaskWriteDeadline(request, timeZone, nowMs);
  if (!deadline.ok) return reject(deadline.reason);

  const devices = host.getCreateSmartTaskCandidateDevices();
  if (devices.state === 'unavailable') return reject('unavailable');
  const device = devices.devices.find((entry) => entry.id === request.deviceId);
  if (!device) return reject('invalid_candidate');
  const candidate = buildValidSmartTaskCandidate(request, deadline.deadlineAtMs, device.rescue, 'always');
  if (!candidate) return reject('invalid_candidate');
  const result = host.createDeferredObjective(request.deviceId, candidate, 'replace');
  if (result.ok) return { ok: true };
  return reject(mapSmartTaskAppReason(result.reason));
};
