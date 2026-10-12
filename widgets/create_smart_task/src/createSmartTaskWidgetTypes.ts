import type {
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type {
  SmartTaskCandidateDevice,
  SmartTaskCandidateRequest,
  SmartTaskWriteRejectReason,
} from '../../../packages/contracts/src/smartTaskEdit';

// One eligible device the user can set a smart task on: the shared candidate
// row (`packages/contracts/src/smartTaskEdit.ts`), under the widget-local name.
export type CreateSmartTaskDevice = SmartTaskCandidateDevice;

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

// Preview response: the priority-coordinated plan estimate plus the resolved
// deadline and a pre-formatted local label so the browser doesn't re-derive it.
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
