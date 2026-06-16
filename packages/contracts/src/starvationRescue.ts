// Browser-safe contract for the starvation-rescue widget. The runtime backend
// produces a `StarvationRescueDevicesPayload` (the currently-starved devices),
// and the widget reuses the deferred-objective plan-preview + create contracts
// for the bounded budget-exempt rescue. Type-only; imports nothing from `lib/`.

import type { SettingsUiPlanStarvationCause } from './settingsUiApi.js';
import type { DeferredObjectivePlanPreviewEstimate } from './deferredObjectivePlanPreview.js';

// One currently-starved device the rescue widget lists. `accumulatedMs` is the
// counted starvation duration (the widget floors it to whole minutes for
// display); `cause` is the producer-resolved flat cause — the widget never
// re-derives it (feedback_layering_resolution_in_producer). Only `cause:
// 'budget'` rows offer the exempt rescue; the rest are informational.
//
// `intendedNormalTargetC` is the device's normal comfort/storage target — the
// value a budget rescue must drive the device to. Present only for temperature
// devices that reported it; null otherwise (the rescue is then not offered).
export type StarvationRescueDevice = {
  deviceId: string;
  deviceName: string;
  cause: SettingsUiPlanStarvationCause;
  accumulatedMs: number;
  intendedNormalTargetC: number | null;
  // Whether the device already has a smart task (deferred objective). Such a
  // device is STILL shown in the held-back list (so the user sees it is
  // struggling), but its rescue button is suppressed — the rescue is a fresh
  // one-shot task and must never replace the device's own task; the existing task
  // is what should bring it to target. Producer-resolved, like `cause`.
  hasSmartTask: boolean;
};

export type StarvationRescueDevicesPayload = {
  state: 'ready';
  devices: StarvationRescueDevice[];
} | {
  state: 'empty';
  // Why the list is empty: nothing is starved (the calm steady state), no data
  // could load, or the widget is still wiring up to the app.
  subtitle: string;
};

// ─── Settings-UI overview device-card rescue (the "Let it run now" chip) ─────
//
// The overview chip offers the SAME bounded budget-exempt rescue as the
// starvation_rescue widget, surfaced from the device card. The settings UI talks
// to the same app methods over these endpoints, so the request/response shapes
// live here (contract-homed) rather than the widget-local types — both the
// runtime handlers (`api.ts` / `setup/settingsUiApi.ts`) and the settings UI
// import them.

export type StarvationRescueRejectReason =
  | 'invalid_request'
  // The device is not a currently-starved BUDGET-caused row (it cleared, its
  // cause changed to capacity, or it never offered a rescue).
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

// The device IDs the overview chip may offer the rescue on, resolved server-side
// from the SAME `getStarvedRescueDevices` list the widget gates on (budget-caused
// + task-free + a known target). The settings UI gates the chip on membership in
// this set, so a shown chip's create call can never be rejected as not-rescuable.
export type SettingsUiStarvationRescueDevicesPayload = {
  rescuableDeviceIds: string[];
};

// Optional bounded-window readout shown on the confirm step (the rescue reaches
// the device's normal target BY `deadlineAtMs`). Mirrors the widget's preview.
export type SettingsUiStarvationRescuePreviewResponse = {
  ok: true;
  deadlineAtMs: number;
  // Pre-formatted local deadline label ("Today 17:00"), server-side in the app
  // timezone so the browser does no Date math.
  deadlineLabel: string;
  estimate: DeferredObjectivePlanPreviewEstimate;
} | {
  ok: false;
  reason: StarvationRescueRejectReason;
};

export type SettingsUiStarvationRescueCreateResponse = {
  ok: true;
  // Whether the just-persisted plan runs the device in the CURRENT clock hour
  // (vs only later, cheaper hours) — drives the honest success flash.
  runsCurrentHour: boolean;
} | {
  ok: false;
  reason: StarvationRescueRejectReason;
};
