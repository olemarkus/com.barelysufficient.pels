import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type { StarvationRescueDevice } from '../../../packages/contracts/src/starvationRescue';
import {
  scheduledHoursIncludeCurrentHour,
  starvationRowOffersRescue,
} from '../../../packages/shared-domain/src/planStarvation';
import {
  formatScheduledHoursWindow,
  formatSmartTaskDeadlineLong,
} from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { buildStarvationRescueDevicesPayload } from './starvationRescueWidgetPayload';
import type {
  StarvationRescueCreateResponse,
  StarvationRescuePreviewResponse,
  StarvationRescueRejectReason,
  StarvationRescueRequest,
} from './starvationRescueWidgetTypes';

// The widget API runs in the app process. It owns the rescue's server-side
// resolution so the browser never does timezone or target math and can't smuggle
// an arbitrary target/deadline past the guardrail:
//
//  - the FRESH rescue TARGET is the device's intended normal target (from the
//    starved list), so the device reaches its normal comfort/storage level;
//  - the FRESH DEADLINE is a fixed near-term horizon from now;
//  - the GUARDRAIL is re-checked here: only a currently-starved BUDGET-caused
//    device gets the budget-exempt rescue (capacity is physical, manual/external
//    are outside PELS's control — see feedback_hard_cap_is_physical).
//
// PREVIEW ≡ PERSIST: the persistence is MERGE-not-replace — when the device
// already has an objective, the rescue preserves THAT objective's target/deadline
// and only adds the budget exemption. So the preview must reflect the merge, not
// the fresh candidate. Both lanes route through the app, which resolves the
// persisted entry from a single shared source (`resolveBudgetExemptionRescueEntry`):
//  - preview → `App.previewStarvationRescuePlan` (projects the resolved entry and
//    returns the resolved deadline so the widget labels/echoes the right value);
//  - create → `App.rescueDeviceWithBudgetExemption` (the merge write), with the
//    now+3h horizon guard applied ONLY to the fresh case (an existing objective's
//    preserved deadline may legitimately sit outside the rescue horizon).
// The fresh rescue candidate simply carries `rescue.exemptFromBudget: 'always'`.

// Near-term deadline for an active rescue: 3 hours gives a thermal device room
// to recover toward its normal target without promising an instant fix, while
// staying "now"-shaped (a rescue, not a scheduled overnight task).
const RESCUE_DEADLINE_HORIZON_MS = 3 * 60 * 60 * 1000;

type StarvationRescueApiApp = {
  getStarvedRescueDevices?: () => StarvationRescueDevice[];
  // Preview the plan the rescue WOULD actually persist. When the device already
  // has an objective, the merge preserves that objective's target/deadline and
  // only adds the budget exemption, so this projects THAT entry (not the fresh
  // candidate) and returns the resolved deadline. See
  // `App.previewStarvationRescuePlan`.
  previewStarvationRescuePlan?: (
    deviceId: string,
    freshRescueCandidate: DeferredObjectivePlanPreviewCandidate,
  ) => { estimate: DeferredObjectivePlanPreviewEstimate; deadlineAtMs: number; hasExistingObjective: boolean };
  // Merge-not-replace rescue: adds the budget exemption to an existing objective,
  // or creates the rescue objective when none exists. See
  // `App.rescueDeviceWithBudgetExemption`.
  rescueDeviceWithBudgetExemption?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ) => { ok: true } | { ok: false; reason: string };
  // Whether the device already has a persisted objective. The create path uses
  // this to skip the now+3h horizon guard when the merge will preserve an
  // existing objective's deadline (the candidate's deadline is then ignored).
  hasDeferredObjectiveForDevice?: (deviceId: string) => boolean;
};

type WidgetApiContext = {
  homey: {
    app?: StarvationRescueApiApp;
    clock?: { getTimezone?: () => string };
  };
};

type WidgetApiBody = { body?: unknown };

const readTimeZone = (homey: WidgetApiContext['homey']): string => {
  const tz = homey.clock?.getTimezone?.();
  return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
};

const parseRescueRequest = (body: unknown): StarvationRescueRequest | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const candidate = body as Partial<StarvationRescueRequest>;
  const deviceId = typeof candidate.deviceId === 'string' ? candidate.deviceId.trim() : '';
  if (!deviceId) return null;
  // `deadlineAtMs` is optional (preview omits it); when present it must be a
  // finite number — the create path validates it's still future + in-horizon.
  const deadlineAtMs = typeof candidate.deadlineAtMs === 'number' && Number.isFinite(candidate.deadlineAtMs)
    ? candidate.deadlineAtMs
    : undefined;
  return deadlineAtMs === undefined ? { deviceId } : { deviceId, deadlineAtMs };
};

// Re-read the LIVE starved list and confirm the requested device is still a
// rescuable (budget-caused) starved row with a known target. This is the
// guardrail's enforcement point: it runs on both preview and create so a stale
// or tampered request can never build a budget-exempt rescue for a
// capacity/manual/external row, or for a device that already recovered.
const resolveRescuableDevice = (
  app: StarvationRescueApiApp | undefined,
): ((deviceId: string) =>
  | { ok: true; targetTemperatureC: number }
  | { ok: false; reason: StarvationRescueRejectReason }) => {
  // `homey.app` is optional in the SDK typing; guard it here so an undefined app
  // rejects cleanly rather than throwing a TypeError on the method lookup.
  const devices = typeof app?.getStarvedRescueDevices === 'function' ? app.getStarvedRescueDevices() : null;
  if (devices === null) {
    return () => ({ ok: false, reason: 'unavailable' });
  }
  const byId = new Map(devices.map((device) => [device.deviceId, device]));
  return (deviceId: string) => {
    const device = byId.get(deviceId);
    if (!device || !starvationRowOffersRescue(device.cause)) {
      return { ok: false, reason: 'not_rescuable' };
    }
    const target = device.intendedNormalTargetC;
    if (target === null || !Number.isFinite(target)) {
      return { ok: false, reason: 'no_target' };
    }
    // The validated finite target flows out typed — no cast at the call site.
    return { ok: true, targetTemperatureC: target };
  };
};

// Build the rescue candidate: a soft temperature objective aimed at the device's
// intended normal target, carrying `exemptFromBudget: 'always'` to bypass
// daily-budget admission while it's scheduled. The OTHER rescue permission —
// `limitLowerPriorityDevices` (the boost) — is added SERVER-SIDE only for
// stepped-eligible devices (see `App.deviceSupportsLimitLowerPriority`); the
// widget can't see the device profile, so it never grants it here. 'always' (not
// 'at_risk') because the user is explicitly asking for power NOW on an already-
// starved device — there is no "wait until at risk" to defer to.
const buildRescueCandidate = (
  targetTemperatureC: number,
  deadlineAtMs: number,
): DeferredObjectivePlanPreviewCandidate => ({
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC,
  deadlineAtMs,
  rescue: { exemptFromBudget: 'always' },
});

const previewReject = (reason: StarvationRescueRejectReason): StarvationRescuePreviewResponse => ({
  ok: false,
  reason,
});

const createReject = (reason: StarvationRescueRejectReason): StarvationRescueCreateResponse => ({
  ok: false,
  reason,
});

const mapAppReason = (reason: string): StarvationRescueRejectReason => {
  if (reason === 'device_not_found') return 'device_not_found';
  if (reason === 'device_not_planned') return 'device_not_planned';
  if (reason === 'device_not_eligible') return 'device_not_eligible';
  // The per-key write refused to persist (transient un-confirmable migration /
  // untrustworthy settings read). Map onto the widget's existing retryable
  // `write_conflict` lane so the user gets the "try again" copy.
  if (reason === 'write_conflict' || reason === 'write_refused') return 'write_conflict';
  return 'invalid_candidate';
};

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

  const rescuable = resolveRescuableDevice(homey.app)(request.deviceId);
  if (!rescuable.ok) return previewReject(rescuable.reason);

  const timeZone = readTimeZone(homey);
  const nowMs = Date.now();
  // The fresh candidate's deadline is the now+3h rescue horizon. The app resolves
  // the ACTUAL persisted outcome: when the device already has an objective, the
  // merge preserves that objective's deadline, so `deadlineAtMs` below reflects
  // what will be persisted (preview ≡ persist), not necessarily now+3h.
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
  const rescuable = resolveRescuableDevice(homey.app)(request.deviceId);
  if (!rescuable.ok) return createReject(rescuable.reason);

  // Persist the EXACT deadline the preview resolved (echoed back in the request),
  // not a fresh now+3h: a confirm left open across an hour boundary must persist
  // what the user saw. A request with no echoed deadline (older widget bundle)
  // falls back to a fresh near-term horizon so the rescue still works.
  const nowMs = Date.now();
  const deadlineAtMs = request.deadlineAtMs ?? nowMs + RESCUE_DEADLINE_HORIZON_MS;
  // A deadline already in the past can never schedule — the active-plan recorder
  // drops plans whose deadline has passed — so reject it on BOTH lanes, including
  // the existing-objective case where the echoed deadline IS that objective's
  // preserved deadline. Persisting an expired deadline would report a clean
  // "success" that silently can't run, instead of the retryable re-preview path.
  if (deadlineAtMs <= nowMs) {
    return createReject('deadline_passed');
  }
  // The upper now+3h horizon bound applies only to a FRESH rescue. When the
  // device already has an objective, the merge preserves THAT objective's
  // deadline (the candidate's is ignored), which may legitimately sit further
  // out, so it must not be rejected on the horizon.
  const hasExistingObjective = homey.app?.hasDeferredObjectiveForDevice?.(request.deviceId) ?? false;
  if (!hasExistingObjective && deadlineAtMs > nowMs + RESCUE_DEADLINE_HORIZON_MS) {
    return createReject('deadline_passed');
  }
  const candidate = buildRescueCandidate(rescuable.targetTemperatureC, deadlineAtMs);
  const result = homey.app.rescueDeviceWithBudgetExemption(request.deviceId, candidate);
  if (!result.ok) return createReject(mapAppReason(result.reason));
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
