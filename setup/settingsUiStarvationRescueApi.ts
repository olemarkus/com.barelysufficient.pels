import type Homey from 'homey';
import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
} from '../packages/contracts/src/deferredObjectivePlanPreview';
import type {
  SettingsUiStarvationRescueCreateResponse,
  SettingsUiStarvationRescueDevicesPayload,
  SettingsUiStarvationRescuePreviewResponse,
  StarvationRescueRejectReason,
} from '../packages/contracts/src/starvationRescue';
import type { WidgetObjectiveWriteResult } from '../packages/contracts/src/widgetHostApi';
import {
  buildRescueCandidate,
  mapAppRescueReason,
  parseRescueRequest,
  RESCUE_DEADLINE_HORIZON_MS,
  resolveRescuableDeviceFromList,
} from '../packages/shared-domain/src/starvationRescueShared';
import { formatSmartTaskDeadlineLong } from '../packages/shared-domain/src/smartTaskDeadlineFormat';
import { scheduledHoursIncludeCurrentHour } from '../packages/shared-domain/src/planStarvation';
import {
  resolveRescuableSettingsDevice,
  type SettingsUiStarvationRescueScope,
} from './settingsUiStarvationRescueScope';

// ─── Overview device-card budget-exempt rescue ("Let it run now") ────────────
//
// The same bounded rescue the starvation_rescue widget offers, surfaced from the
// overview device card. These handlers run in the app process and reach the SAME
// app methods the widget calls (`getStarvedRescueDevices`,
// `previewStarvationRescuePlan`, `rescueDeviceWithBudgetExemption`), reusing the
// shared request/candidate/gating helpers so the two surfaces resolve the rescue
// identically. There is NO standing per-device toggle here — a budget exemption
// is always BOUNDED to a fresh deferred objective (≈ now+3h, until the device
// reaches its normal target), per feedback_hard_cap_is_physical.

type RescueApiContext = {
  homey: Homey.App['homey'];
};

// Budget-exempt rescue surface — the same app methods the starvation_rescue
// widget calls. Optional like the rest (the app may be unwired during restart).
type RescueApiApp = Homey.App & SettingsUiStarvationRescueScope & {
  previewStarvationRescuePlan?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ) => { estimate: DeferredObjectivePlanPreviewEstimate; deadlineAtMs: number; hasExistingObjective: boolean };
  rescueDeviceWithBudgetExemption?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ) => WidgetObjectiveWriteResult;
};

const getApp = (homey: Homey.App['homey']): RescueApiApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as RescueApiApp;
};

const previewRescueReject = (
  reason: StarvationRescueRejectReason,
): SettingsUiStarvationRescuePreviewResponse => ({ ok: false, reason });

const createRescueReject = (
  reason: StarvationRescueRejectReason,
): SettingsUiStarvationRescueCreateResponse => ({ ok: false, reason });

// The device IDs the overview chip may offer the rescue on — the same gate the
// widget uses (task-free + a known target), resolved from
// `getStarvedRescueDevices`. A snapshot: the create path re-validates against the
// live list, so a chip shown from a stale set can still be rejected.
export const getSettingsUiStarvationRescueDevices = (
  { homey }: RescueApiContext,
): SettingsUiStarvationRescueDevicesPayload => {
  const app = getApp(homey);
  const devices = typeof app?.getStarvedRescueDevices === 'function' ? app.getStarvedRescueDevices() : null;
  const rescuableDeviceIds = (devices ?? [])
    .filter((device) => resolveRescuableDeviceFromList([device], device.deviceId).ok)
    .map((device) => device.deviceId);
  return { rescuableDeviceIds };
};

export const previewSettingsUiStarvationRescue = (
  { homey, body }: RescueApiContext & { body?: unknown },
): SettingsUiStarvationRescuePreviewResponse => {
  const request = parseRescueRequest(body);
  if (!request) return previewRescueReject('invalid_request');
  const app = getApp(homey);
  if (typeof app?.previewStarvationRescuePlan !== 'function') return previewRescueReject('unavailable');

  const rescuable = resolveRescuableSettingsDevice(app, request.deviceId);
  if (!rescuable.ok) return previewRescueReject(rescuable.reason);

  const nowMs = Date.now();
  const timeZone = homey.clock.getTimezone();
  // A rescue is always a fresh task (task-having devices are excluded), so the
  // deadline is simply the now+3h rescue horizon — the fresh candidate IS what
  // persists (preview ≡ persist).
  const candidate = buildRescueCandidate(rescuable.targetTemperatureC, nowMs + RESCUE_DEADLINE_HORIZON_MS);
  const { estimate, deadlineAtMs } = app.previewStarvationRescuePlan(request.deviceId, candidate);
  return {
    ok: true,
    deadlineAtMs,
    deadlineLabel: formatSmartTaskDeadlineLong(deadlineAtMs, nowMs, timeZone),
    estimate,
  };
};

export const createSettingsUiStarvationRescue = (
  { homey, body }: RescueApiContext & { body?: unknown },
): SettingsUiStarvationRescueCreateResponse => {
  const request = parseRescueRequest(body);
  if (!request) return createRescueReject('invalid_request');
  const app = getApp(homey);
  if (typeof app?.rescueDeviceWithBudgetExemption !== 'function') return createRescueReject('unavailable');

  // Re-check the guardrail at create time against the LIVE list: a row that
  // recovered (or whose cause changed) between preview and confirm is rejected
  // rather than silently granted a budget exemption.
  const rescuable = resolveRescuableSettingsDevice(app, request.deviceId);
  if (!rescuable.ok) return createRescueReject(rescuable.reason);

  // Persist the EXACT deadline the preview resolved (echoed back), or a fresh
  // near-term horizon when none was echoed (a plain confirm without a preview).
  // Either way the deadline must be strictly future AND within the rescue horizon.
  const nowMs = Date.now();
  const deadlineAtMs = request.deadlineAtMs ?? nowMs + RESCUE_DEADLINE_HORIZON_MS;
  if (deadlineAtMs <= nowMs || deadlineAtMs > nowMs + RESCUE_DEADLINE_HORIZON_MS) {
    return createRescueReject('deadline_passed');
  }
  const candidate = buildRescueCandidate(rescuable.targetTemperatureC, deadlineAtMs);
  const result = app.rescueDeviceWithBudgetExemption(request.deviceId, candidate);
  if (!result.ok) return createRescueReject(mapAppRescueReason(result.reason));
  // Resolve the success flash against the JUST-PERSISTED plan at THIS moment
  // (a pure re-derivation, no persist); absent the preview method, fall back to
  // the honest-conservative "not running now".
  const post = app.previewStarvationRescuePlan?.(request.deviceId, candidate);
  return {
    ok: true,
    runsCurrentHour: post ? scheduledHoursIncludeCurrentHour(post.estimate.scheduledHours, nowMs) : false,
  };
};
