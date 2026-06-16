import { handleWidgetClientLog, type WidgetClientLogContext } from '../../_shared/widgetClientLogApi';
import type { StarvationRescueHostApi } from '../../../packages/contracts/src/widgetHostApi';
import {
  scheduledHoursIncludeCurrentHour,
} from '../../../packages/shared-domain/src/planStarvation';
import {
  buildRescueCandidate,
  mapAppRescueReason,
  parseRescueRequest,
  RESCUE_DEADLINE_HORIZON_MS,
  resolveRescuableDeviceFromList,
} from '../../../packages/shared-domain/src/starvationRescueShared';
import {
  formatScheduledHoursWindow,
  formatSmartTaskDeadlineLong,
} from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { buildStarvationRescueDevicesPayload } from './starvationRescueWidgetPayload';
import type {
  StarvationRescueCreateResponse,
  StarvationRescuePreviewResponse,
  StarvationRescueRejectReason,
} from './starvationRescueWidgetTypes';

// The widget API runs in the app process. It owns the rescue's server-side
// resolution so the browser never does timezone or target math and can't smuggle
// an arbitrary target/deadline past the guardrail:
//
//  - the FRESH rescue TARGET is the device's intended normal target (from the
//    starved list), so the device reaches its normal comfort/storage level;
//  - the FRESH DEADLINE is a fixed near-term horizon from now;
//  - the GUARDRAIL is re-checked here: only a currently-starved BUDGET-caused
//    device gets the budget-exempt rescue (capacity is physical, the hard cap is
//    not a tuning knob — see feedback_hard_cap_is_physical).
//
// PREVIEW ≡ PERSIST: a rescue is always a FRESH task — task-having devices are
// excluded from the rescue (`App.getStarvedRescueDevices`), so there is no merge.
// Both lanes REUSE the create engine, which resolves the candidate's opt-in
// permissions through one shared gate (`gateCandidateExtraPermissions`), so the
// preview and the persisted plan can never diverge:
//  - preview → `App.previewStarvationRescuePlan` (delegates to
//    `previewDeferredObjectivePlan`; the fresh candidate's now+3h deadline IS what
//    persists, so the widget labels/echoes it directly);
//  - create → `App.rescueDeviceWithBudgetExemption` (delegates to
//    `createDeferredObjective`), with the now+3h horizon guard always applied.
// The fresh rescue candidate carries both rescue permissions; the create engine
// keeps the budget exemption for any device and gates the limit-lower-priority one.
//
// The request parsing, near-term horizon, rescuable-device gating, candidate
// building, and reason mapping are SHARED with the overview device-card rescue
// path via `packages/shared-domain/src/starvationRescueShared.ts`, so the two
// surfaces resolve the rescue identically.

type WidgetApiContext = {
  homey: {
    app?: StarvationRescueHostApi;
    clock?: { getTimezone?: () => string };
  };
};

type WidgetApiBody = { body?: unknown };

const readTimeZone = (homey: WidgetApiContext['homey']): string => {
  const tz = homey.clock?.getTimezone?.();
  return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
};

// Re-read the LIVE starved list and resolve the requested device against it.
// `homey.app` is optional in the SDK typing; guard the getter here so an
// undefined app rejects cleanly (the shared resolver maps a `null` list to
// `unavailable`).
const resolveRescuableDevice = (app: StarvationRescueHostApi | undefined, deviceId: string) => {
  const devices = typeof app?.getStarvedRescueDevices === 'function' ? app.getStarvedRescueDevices() : null;
  return resolveRescuableDeviceFromList(devices, deviceId);
};

const previewReject = (reason: StarvationRescueRejectReason): StarvationRescuePreviewResponse => ({
  ok: false,
  reason,
});

const createReject = (reason: StarvationRescueRejectReason): StarvationRescueCreateResponse => ({
  ok: false,
  reason,
});

export const getStarvationRescueDevices = async (
  { homey }: WidgetApiContext,
): Promise<ReturnType<typeof buildStarvationRescueDevicesPayload>> => {
  const devices = typeof homey.app?.getStarvedRescueDevices === 'function'
    ? homey.app.getStarvedRescueDevices()
    : null;
  return buildStarvationRescueDevicesPayload({ devices });
};

export const previewStarvationRescue = async (
  { homey, body }: WidgetApiContext & WidgetApiBody,
): Promise<StarvationRescuePreviewResponse> => {
  const request = parseRescueRequest(body);
  if (!request) return previewReject('invalid_request');
  // Call on `homey.app` directly to preserve `this` — the app methods read
  // instance state, so a detached reference would throw.
  if (typeof homey.app?.previewStarvationRescuePlan !== 'function') return previewReject('unavailable');

  const rescuable = resolveRescuableDevice(homey.app, request.deviceId);
  if (!rescuable.ok) return previewReject(rescuable.reason);

  const timeZone = readTimeZone(homey);
  const nowMs = Date.now();
  // A rescue is always a fresh task (task-having devices are excluded), so the
  // deadline is simply the now+3h rescue horizon — the fresh candidate IS what
  // persists (preview ≡ persist).
  const candidate = buildRescueCandidate(rescuable.targetTemperatureC, nowMs + RESCUE_DEADLINE_HORIZON_MS);
  const { estimate, deadlineAtMs } = homey.app.previewStarvationRescuePlan(request.deviceId, candidate);
  return {
    ok: true,
    deadlineAtMs,
    deadlineLabel: formatSmartTaskDeadlineLong(deadlineAtMs, nowMs, timeZone),
    scheduledWindowLabel: formatScheduledHoursWindow(estimate.scheduledHours, timeZone),
    estimate,
  };
};

export const createStarvationRescue = async (
  { homey, body }: WidgetApiContext & WidgetApiBody,
): Promise<StarvationRescueCreateResponse> => {
  const request = parseRescueRequest(body);
  if (!request) return createReject('invalid_request');
  if (typeof homey.app?.rescueDeviceWithBudgetExemption !== 'function') return createReject('unavailable');

  // Re-check the guardrail at create time against the LIVE list: the device must
  // still be a budget-starved rescuable row. A row that recovered (or whose
  // cause changed) between preview and confirm is rejected rather than silently
  // granted a budget exemption.
  const rescuable = resolveRescuableDevice(homey.app, request.deviceId);
  if (!rescuable.ok) return createReject(rescuable.reason);

  // Persist the EXACT deadline the preview resolved (echoed back in the request),
  // not a fresh now+3h: a confirm left open across an hour boundary must persist
  // what the user saw. A request with no echoed deadline (older widget bundle)
  // falls back to a fresh near-term horizon so the rescue still works.
  const nowMs = Date.now();
  const deadlineAtMs = request.deadlineAtMs ?? nowMs + RESCUE_DEADLINE_HORIZON_MS;
  // A rescue is always a fresh task on the now+3h horizon, so the echoed deadline
  // must be strictly future AND within that horizon. A deadline that slipped into
  // the past (the active-plan recorder drops it) or was tampered beyond the
  // horizon is rejected to the retryable re-preview path rather than persisted as
  // a clean "success" that silently can't run.
  if (deadlineAtMs <= nowMs || deadlineAtMs > nowMs + RESCUE_DEADLINE_HORIZON_MS) {
    return createReject('deadline_passed');
  }
  const candidate = buildRescueCandidate(rescuable.targetTemperatureC, deadlineAtMs);
  const result = homey.app.rescueDeviceWithBudgetExemption(request.deviceId, candidate);
  if (!result.ok) return createReject(mapAppRescueReason(result.reason));
  // Resolve the success flash against the JUST-PERSISTED plan at THIS moment, not
  // the preview-time value: a confirm left open across an hour boundary must
  // flash the live truth. `previewStarvationRescuePlan` is a pure re-derivation
  // (no persist) of the now-persisted objective; absent it, fall back to the
  // honest-conservative "queued".
  const post = homey.app.previewStarvationRescuePlan?.(request.deviceId, candidate);
  return {
    ok: true,
    runsCurrentHour: post ? scheduledHoursIncludeCurrentHour(post.estimate.scheduledHours, nowMs) : false,
  };
};

export const logClientError = (context: WidgetClientLogContext): { ok: boolean } => (
  handleWidgetClientLog('starvation_rescue', context)
);
