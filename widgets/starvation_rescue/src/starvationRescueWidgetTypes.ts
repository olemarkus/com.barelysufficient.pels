import type {
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';

// Re-export the browser-safe payload so the widget's render/controller import
// from one place. The payload is produced by the runtime backend
// (`App.getStarvedRescueDevices`) and shaped by `buildStarvationRescueDevicesPayload`.
export type {
  StarvationRescueDevice,
  StarvationRescueDevicesPayload,
} from '../../../packages/contracts/src/starvationRescue';

// The rescue request the widget POSTs. The widget never resolves the rescue's
// TARGET (the device's intended normal target is resolved SERVER-SIDE so the
// browser can't smuggle an arbitrary target past the budget-cause guardrail).
//
// `deadlineAtMs` is the deadline the PREVIEW resolved and the user saw. The
// create path echoes it back rather than recomputing a fresh now+3h, so a
// confirm left open across an hour boundary persists the exact previewed
// deadline/cost — or is rejected (`deadline_passed`) and re-previewed if it has
// since slipped past or out of the rescue horizon. Omitted on a preview request
// (the preview computes the deadline); required on a create.
export type StarvationRescueRequest = {
  deviceId: string;
  deadlineAtMs?: number;
};

// Preview response: the in-isolation plan estimate plus the resolved near-term
// deadline and a pre-formatted local deadline label (server-side, app timezone).
export type StarvationRescuePreviewResponse = {
  ok: true;
  deadlineAtMs: number;
  deadlineLabel: string;
  // The scheduled clock-hour window ("02:00–04:00"), formatted server-side in
  // the Homey timezone. Null when no hours are scheduled.
  scheduledWindowLabel: string | null;
  estimate: DeferredObjectivePlanPreviewEstimate;
} | {
  ok: false;
  reason: StarvationRescueRejectReason;
};

export type StarvationRescueCreateResponse = {
  ok: true;
  // Server-resolved against the JUST-PERSISTED plan at create time: does it run
  // the device in the CURRENT clock hour (vs only later, cheaper hours)? Drives
  // the honest success flash. Resolved on the create response — not the preview —
  // so a confirm left open across an hour boundary flashes the live truth, never
  // a stale preview-time value.
  runsCurrentHour: boolean;
} | {
  ok: false;
  reason: StarvationRescueRejectReason;
};

export type StarvationRescueRejectReason =
  | 'invalid_request'
  // The device is not a currently-starved BUDGET-caused row (it cleared, its
  // cause changed to capacity, or it never offered a rescue).
  // The guardrail: only budget starvation gets the budget-exempt rescue.
  | 'not_rescuable'
  // No intended normal target known for the device yet, so there is nothing to
  // aim the rescue at.
  | 'no_target'
  // The resolved near-term deadline slipped into the past (clock skew) — retryable.
  | 'deadline_passed'
  | 'device_not_found'
  | 'device_not_planned'
  | 'device_not_eligible'
  | 'invalid_candidate'
  // The hardened write primitive refused (suspected transient-empty settings
  // read while other tasks are live). Transient — the user can retry.
  | 'write_conflict'
  | 'unavailable';
