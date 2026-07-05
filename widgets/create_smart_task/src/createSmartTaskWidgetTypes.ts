import type {
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type {
  DeferredObjectiveSettingsKind,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import type {
  SmartTaskCandidateRequest,
  SmartTaskWriteRejectReason,
} from '../../../packages/contracts/src/smartTaskEdit';
import type {
  SmartTaskDeviceGroup,
} from '../../../packages/shared-domain/src/smartTaskDevicePickerOrder';

// One eligible device the user can set a smart task on. Kind sets the goal
// unit (°C for temperature, % for EV charge level); the bounds drive the goal
// stepper. `currentValue` seeds the stepper and the "now → target" hint, null
// when the device hasn't reported a reading yet.
export type CreateSmartTaskDevice = {
  deviceId: string;
  deviceName: string;
  kind: DeferredObjectiveSettingsKind;
  // Display family for the picker: drives the intentional group order and the
  // per-row type icon (thermostats, then water heaters, then EV chargers).
  group: SmartTaskDeviceGroup;
  unitSymbol: '°C' | '%';
  goalMin: number;
  goalMax: number;
  goalStep: number;
  defaultGoal: number;
  currentValue: number | null;
  // Whether the "May limit lower-priority devices" toggle would ACTUALLY change
  // this device's plan — true only for a stepped-load device at top priority
  // (priority 1), the only context the planner's reserved-headroom promotion
  // (`fullyReserved`) honours. Gated on effect so the compose screen never
  // offers a permission that would be a no-op for this device. The budget-exempt
  // toggle has no such gate (any device can exceed the soft daily budget).
  supportsLimitLowerPriority: boolean;
};

export type CreateSmartTaskDevicesPayload = {
  state: 'ready';
  devices: CreateSmartTaskDevice[];
} | {
  // No eligible devices to set a task on. A calm, expected state (the hint tells
  // the user how to make a device appear) — never the danger tone.
  state: 'empty';
  subtitle: string;
  hint: string | null;
} | {
  // The device fetch FAILED (a real `/devices` round-trip rejected), distinct
  // from `empty`. The widget can recover in place via a tap-to-retry affordance
  // that re-runs the load, so a stuck load no longer needs a close/reopen. The
  // subtitle/retry copy is the fixed `loadError`/`loadErrorRetry` pair (resolved
  // in render), so this carries no payload — the discriminant is the message.
  state: 'error';
};

// The candidate the user is composing and the reject vocabulary are the shared
// smart-task contract (`packages/contracts/src/smartTaskEdit.ts`) — the
// settings-UI edit lane sends the same request to the same app methods.
// Re-exported under the widget-local names so widget code keeps one import home.
export type CreateSmartTaskCandidateRequest = SmartTaskCandidateRequest;

// Preview response: the in-isolation plan estimate plus the resolved deadline
// and a pre-formatted local deadline label so the browser doesn't re-derive it.
export type CreateSmartTaskPreviewResponse = {
  ok: true;
  deadlineAtMs: number;
  // "Tomorrow 07:00" / "Today 16:00" style label, resolved server-side in the
  // app timezone so the preview's window labels stay consistent with it.
  deadlineLabel: string;
  // The scheduled clock-hour window ("02:00–04:00" / "02:00, 03:00, 14:00"),
  // formatted SERVER-SIDE in the Homey timezone from `estimate.scheduledHours`.
  // Null when no hours are scheduled. The widget displays this verbatim instead
  // of formatting the absolute `startsAtMs` client-side, so the window can never
  // drift into the phone's timezone when it differs from the Homey one (the
  // deadlineLabel is likewise server-formatted — they must agree).
  scheduledWindowLabel: string | null;
  estimate: DeferredObjectivePlanPreviewEstimate;
} | {
  ok: false;
  reason: CreateSmartTaskRejectReason;
};

export type CreateSmartTaskCreateResponse = {
  ok: true;
} | {
  ok: false;
  reason: CreateSmartTaskRejectReason;
};

export type CreateSmartTaskRejectReason = SmartTaskWriteRejectReason;
