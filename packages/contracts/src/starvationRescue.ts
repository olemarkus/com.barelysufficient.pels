// Browser-safe contract for the starvation-rescue widget. The runtime backend
// produces a `StarvationRescueDevicesPayload` (the currently-starved devices),
// and the widget reuses the deferred-objective plan-preview + create contracts
// for the bounded rescue. Type-only; imports nothing from `lib/`.

import type { DeferredObjectivePlanPreviewEstimate } from './deferredObjectivePlanPreview.js';
import type { SmartTaskHomeScope } from './smartTaskHomeScope.js';

// One currently-starved device the rescue widget lists. `accumulatedMs` is the
// counted starvation duration (the widget renders it as whole minutes, rolling
// over into hours).
//
// `intendedNormalTargetC` is the device's normal comfort/storage target — the
// value the rescue must drive the device to. Present only for temperature
// devices that reported it; null otherwise (the rescue is then not offered).
export type StarvationRescueDevice = {
  deviceId: string;
  deviceName: string;
  accumulatedMs: number;
  intendedNormalTargetC: number | null;
  // Current semantic authority for the rescue action. A transient unavailable
  // Main authority keeps the diagnostic row visible while disabling rescue;
  // durable sub-home and active-source rows are omitted by the producer.
  smartTaskHomeScope: Exclude<SmartTaskHomeScope, 'sub_home' | 'source_device'>;
  // Whether the device already has a smart task (deferred objective). Such a
  // device is STILL shown in the held-back list (so the user sees it is
  // struggling), but its rescue button is suppressed — the rescue is a fresh
  // one-shot task and must never replace the device's own task; the existing task
  // is what should bring it to target. Producer-resolved.
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

// NOT composed from `SmartTaskWriteRejectReason` (smartTaskEdit.ts): the two
// vocabularies overlap but differ — the rescue lane has no `invalid_ready_by`
// (its deadline is a fixed now+3h horizon) and adds two rescue-only gates.
export type StarvationRescueRejectReason =
  | 'invalid_request'
  // The device is not a currently-rescuable starved row (it cleared, or it has a
  // smart task of its own that will bring it back).
  | 'not_rescuable'
  // No intended normal target known for the device yet, so there is nothing to
  // aim the rescue at.
  | 'no_target'
  // The resolved near-term deadline slipped into the past (clock skew) — retryable.
  | 'deadline_passed'
  | 'device_not_found'
  | 'device_not_planned'
  | 'device_not_eligible'
  // The device belongs to a separate-meter sub-home; smart tasks (and so the
  // rescue, which is a smart-task create) are main-home-only in v1. The live
  // starved list (`getStarvedRescueDevices`) excludes sub-home devices, so this
  // surfaces only on the stale-row race — the device relocated between listing
  // and tap — or a tampered request; either way the surfaces show the dedicated
  // separate-meter copy instead of collapsing into `invalid_candidate`.
  | 'device_in_sub_home'
  | 'invalid_candidate'
  // The hardened write primitive refused (suspected transient-empty settings
  // read while other tasks are live). Transient — the user can retry.
  | 'write_conflict'
  | 'unavailable';

// The device IDs the overview chip may offer the rescue on, resolved server-side
// from the SAME `getStarvedRescueDevices` list the widget gates on (task-free
// + a known target). The settings UI gates the chip on membership in this set,
// which keeps a stale affordance rare — but the set is a snapshot, and
// `resolveRescuableDeviceFromList` re-checks live state on preview AND create, so
// a shown chip's call can still come back `not_rescuable` / `no_target`.
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
