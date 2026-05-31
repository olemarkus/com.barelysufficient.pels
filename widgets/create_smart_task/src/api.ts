import { resolveDeferredObjectiveDeadline } from '../../../lib/objectives/deferredObjectives';
import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import {
  normalizeDeferredObjectiveSettingsEntry,
  type DeferredObjectiveSettingsKind,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import {
  formatScheduledHoursWindow,
  formatSmartTaskDeadlineLong,
} from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { buildCreateSmartTaskDevicesPayload } from './createSmartTaskWidgetPayload';
import type {
  CreateSmartTaskCandidateRequest,
  CreateSmartTaskCreateResponse,
  CreateSmartTaskDevicesPayload,
  CreateSmartTaskPreviewResponse,
  CreateSmartTaskRejectReason,
} from './createSmartTaskWidgetTypes';

// The widget API runs in the app process. It owns the server-side "Ready by"
// (HH:mm local) → absolute `deadlineAtMs` conversion (DST-aware, against the
// Homey timezone) so the browser never does timezone math, mirroring the
// deadline Flow cards' `resolveReadyByToDeadlineAtMs`. The app methods it
// forwards to (`previewDeferredObjectivePlan`, `createDeferredObjective`) are
// the single source of truth for projection and persistence.

type CreateSmartTaskApiApp = {
  // Runtime-planned devices the widget may offer (managed snapshot). The widget
  // offers ONLY these so it never presents a device whose create would be
  // rejected as `device_not_planned`. See app.getCreateSmartTaskCandidateDevices.
  getCreateSmartTaskCandidateDevices?: () => TargetDeviceSnapshot[];
  previewDeferredObjectivePlan?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ) => DeferredObjectivePlanPreviewEstimate;
  createDeferredObjective?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ) => { ok: true } | { ok: false; reason: string };
};

type WidgetApiContext = {
  homey: {
    app?: CreateSmartTaskApiApp;
    clock?: { getTimezone?: () => string };
  };
};

type WidgetApiBody = { body?: unknown };

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Outer bound for a client-echoed previewed deadline. The "Ready by" resolver
// only ever places a deadline within the next ~24h (today, or rolled to
// tomorrow); 36h absorbs a 25-hour DST day plus slack while still rejecting an
// implausible or tampered far-future timestamp. The client deadline is never
// trusted as the persisted value beyond `(now, now + MAX_DEADLINE_HORIZON_MS]`.
const MAX_DEADLINE_HORIZON_MS = 36 * 60 * 60 * 1000;

const readTimeZone = (homey: WidgetApiContext['homey']): string => {
  const tz = homey.clock?.getTimezone?.();
  return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
};

const isObjectiveKind = (value: unknown): value is DeferredObjectiveSettingsKind => (
  value === 'temperature' || value === 'ev_soc'
);

// Parse and shape-validate the candidate request body. Returns null on any
// malformed field; the deeper range/eligibility validation happens in the app
// methods (via the shared normalizer + device-kind check), so this only guards
// against structurally-invalid input reaching them.
const parseCandidateRequest = (body: unknown): CreateSmartTaskCandidateRequest | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const candidate = body as Partial<CreateSmartTaskCandidateRequest>;
  const deviceId = typeof candidate.deviceId === 'string' ? candidate.deviceId.trim() : '';
  if (!deviceId) return null;
  if (!isObjectiveKind(candidate.kind)) return null;
  if (typeof candidate.target !== 'number' || !Number.isFinite(candidate.target)) return null;
  const readyByLocalTime = typeof candidate.readyByLocalTime === 'string'
    ? candidate.readyByLocalTime.trim()
    : '';
  if (!LOCAL_TIME_PATTERN.test(readyByLocalTime)) return null;
  // Carry the optional client-echoed previewed deadline only when it is a finite
  // number; any other shape is dropped (the create path then re-resolves from
  // `readyByLocalTime`). Range/freshness validation happens in `resolveCreateDeadline`.
  const deadlineAtMs = typeof candidate.deadlineAtMs === 'number' && Number.isFinite(candidate.deadlineAtMs)
    ? candidate.deadlineAtMs
    : undefined;
  return { deviceId, kind: candidate.kind, target: candidate.target, readyByLocalTime, deadlineAtMs };
};

// Resolve the request's local ready-by time to a future absolute deadline.
// Returns null when the time can't be placed in the future (should not happen
// for a valid HH:mm given the resolver rolls to tomorrow, but guarded).
const resolveDeadline = (
  request: CreateSmartTaskCandidateRequest,
  timeZone: string,
  nowMs: number,
): number | null => {
  const resolution = resolveDeferredObjectiveDeadline({
    nowMs,
    timeZone,
    deadlineLocalTime: request.readyByLocalTime,
  });
  if (resolution.deadlineAtMs === null || resolution.deadlineAtMs <= nowMs) return null;
  return resolution.deadlineAtMs;
};

// Resolve the deadline the CREATE will persist. When the client echoes back the
// deadline the preview showed (`request.deadlineAtMs`), use that exact value so
// the created task can never disagree with the previewed window — but only
// after validating it is still strictly in the future and within a sane
// horizon. A previewed time that slipped into the past while the user lingered
// (the same-minute boundary case) is rejected with `deadline_passed` rather
// than silently re-resolved to tomorrow. When no client deadline is supplied
// (direct API callers with no preview step), fall back to server-side
// re-resolution from `readyByLocalTime` (`invalid_ready_by` when unresolvable).
const resolveCreateDeadline = (
  request: CreateSmartTaskCandidateRequest,
  timeZone: string,
  nowMs: number,
): { ok: true; deadlineAtMs: number } | { ok: false; reason: CreateSmartTaskRejectReason } => {
  if (request.deadlineAtMs !== undefined) {
    if (request.deadlineAtMs <= nowMs || request.deadlineAtMs > nowMs + MAX_DEADLINE_HORIZON_MS) {
      return { ok: false, reason: 'deadline_passed' };
    }
    return { ok: true, deadlineAtMs: request.deadlineAtMs };
  }
  const deadlineAtMs = resolveDeadline(request, timeZone, nowMs);
  if (deadlineAtMs === null) return { ok: false, reason: 'invalid_ready_by' };
  return { ok: true, deadlineAtMs };
};

// Build and VALIDATE the preview/persist candidate (the settings entry shape
// minus `enabled`) from a request + resolved deadline. Validation runs through
// the same `normalizeDeferredObjectiveSettingsEntry` the create path uses, so a
// preview and a create reject identical out-of-range targets — the user never
// sees an optimistic preview for a candidate the create would reject. Returns
// null when the per-kind target is out of range. The runtime create path
// re-validates and additionally checks device-kind eligibility.
const buildValidCandidate = (
  request: CreateSmartTaskCandidateRequest,
  deadlineAtMs: number,
): DeferredObjectivePlanPreviewCandidate | null => {
  const candidate: DeferredObjectivePlanPreviewCandidate = request.kind === 'ev_soc'
    ? { kind: 'ev_soc', enforcement: 'soft', targetPercent: request.target, deadlineAtMs }
    : { kind: 'temperature', enforcement: 'soft', targetTemperatureC: request.target, deadlineAtMs };
  return normalizeDeferredObjectiveSettingsEntry({ ...candidate, enabled: true }) ? candidate : null;
};

const previewReject = (reason: CreateSmartTaskRejectReason): CreateSmartTaskPreviewResponse => ({
  ok: false,
  reason,
});

const createReject = (reason: CreateSmartTaskRejectReason): CreateSmartTaskCreateResponse => ({
  ok: false,
  reason,
});

const mapAppReason = (reason: string): CreateSmartTaskRejectReason => {
  if (reason === 'device_not_found') return 'device_not_found';
  if (reason === 'device_not_planned') return 'device_not_planned';
  if (reason === 'device_not_eligible') return 'device_not_eligible';
  // The per-key write refused to persist (transient un-confirmable migration /
  // untrustworthy settings read). Map onto the widget's existing retryable
  // `write_conflict` lane so the user gets the "try again" copy rather than a
  // false success.
  if (reason === 'write_conflict' || reason === 'write_refused') return 'write_conflict';
  return 'invalid_candidate';
};

export const getCreateSmartTaskDevices = async (
  { homey }: WidgetApiContext,
): Promise<CreateSmartTaskDevicesPayload> => {
  const devices = typeof homey.app?.getCreateSmartTaskCandidateDevices === 'function'
    ? homey.app.getCreateSmartTaskCandidateDevices()
    : [];
  return buildCreateSmartTaskDevicesPayload({ devices });
};

export const previewCreateSmartTask = async (
  { homey, body }: WidgetApiContext & WidgetApiBody,
): Promise<CreateSmartTaskPreviewResponse> => {
  const request = parseCandidateRequest(body);
  if (!request) return previewReject('invalid_request');
  // Call the app method on `homey.app` (not via an extracted const): the method
  // relies on its `this` (`this.latestTargetSnapshot`, `this.getUiPickerDevices()`,
  // …), so a detached reference would throw a runtime TypeError.
  if (typeof homey.app?.previewDeferredObjectivePlan !== 'function') return previewReject('unavailable');

  const timeZone = readTimeZone(homey);
  const nowMs = Date.now();
  const deadlineAtMs = resolveDeadline(request, timeZone, nowMs);
  if (deadlineAtMs === null) return previewReject('invalid_ready_by');

  const candidate = buildValidCandidate(request, deadlineAtMs);
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
  const request = parseCandidateRequest(body);
  if (!request) return createReject('invalid_request');
  // Call on `homey.app` directly to preserve `this` — `createDeferredObjective`
  // reads `this.latestTargetSnapshot` / `this.homey.settings`, so a detached
  // reference would throw a runtime TypeError.
  if (typeof homey.app?.createDeferredObjective !== 'function') return createReject('unavailable');

  const timeZone = readTimeZone(homey);
  const nowMs = Date.now();
  const deadline = resolveCreateDeadline(request, timeZone, nowMs);
  if (!deadline.ok) return createReject(deadline.reason);

  const candidate = buildValidCandidate(request, deadline.deadlineAtMs);
  if (!candidate) return createReject('invalid_candidate');
  const result = homey.app.createDeferredObjective(request.deviceId, candidate);
  if (result.ok) return { ok: true };
  return createReject(mapAppReason(result.reason));
};
