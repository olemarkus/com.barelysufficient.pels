// Browser-safe contract for the starvation-rescue widget. The runtime backend
// produces a `StarvationRescueDevicesPayload` (the currently-starved devices),
// and the widget reuses the deferred-objective plan-preview + create contracts
// for the bounded budget-exempt rescue. Type-only; imports nothing from `lib/`.

import type { SettingsUiPlanStarvationCause } from './settingsUiApi.js';

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
