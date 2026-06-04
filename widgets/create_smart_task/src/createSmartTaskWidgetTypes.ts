import type {
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type {
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsKind,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
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
  // The device's CURRENT standing rescue permissions (granted via Flow / the
  // rescue-boost lane), if any. Read-only CONTEXT for the compose screen so the
  // "Extra permissions" toggles read as additive on top of what already stands —
  // not the whole picture. Undefined when the device has no standing grant (the
  // section then behaves as before). This never changes the additive write
  // semantics (the create path's `preserve` policy is untouched); it is purely
  // for visibility/authoritativeness.
  standingRescue?: DeferredObjectiveRescuePermissions;
};

export type CreateSmartTaskDevicesPayload = {
  state: 'ready';
  devices: CreateSmartTaskDevice[];
} | {
  state: 'empty';
  // Why the list is empty: no eligible devices, or the data couldn't load.
  subtitle: string;
  hint: string | null;
};

// The candidate the user is composing. `readyByLocalTime` is a 24-hour local
// "HH:mm" string; the server converts it to an absolute `deadlineAtMs` against
// the Homey timezone (DST-aware) so the browser never does timezone math.
export type CreateSmartTaskCandidateRequest = {
  deviceId: string;
  kind: DeferredObjectiveSettingsKind;
  target: number;
  readyByLocalTime: string;
  // The absolute deadline the PREVIEW resolved and showed the user, echoed back
  // on create so the persisted task matches exactly what the preview promised.
  // Optional: absent for direct API callers (no preview step), in which case
  // `/create` re-resolves `readyByLocalTime` server-side as before. When present
  // it is validated (strictly future, within a sane horizon) and rejected with
  // `deadline_passed` if it has since slipped into the past — never silently
  // rolled to the next day. The server never trusts it as the persisted value
  // without that validation.
  deadlineAtMs?: number;
  // Optional "Extra permissions" the user opted into for this task (both default
  // off). `exemptFromBudget` lets the task exceed the soft daily budget;
  // `limitLowerPriorityDevices` lets it limit lower-priority devices. Both are
  // re-gated SERVER-side (the widget's visibility is not trusted): the latter is
  // dropped unless the device is stepped-load eligible, and persists only
  // alongside `exemptFromBudget` (it is inert without it). Sent as plain booleans;
  // the server maps an opted-in permission to the `'always'` rescue mode.
  exemptFromBudget?: boolean;
  limitLowerPriorityDevices?: boolean;
};

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

export type CreateSmartTaskRejectReason =
  | 'invalid_request'
  | 'invalid_ready_by'
  // The previewed deadline the client echoed back on create has since slipped
  // into the past (or is implausibly far in the future). Rejected so the
  // created task can never disagree with the previewed window — the widget
  // re-previews to resolve a fresh future deadline. Retryable.
  | 'deadline_passed'
  | 'device_not_found'
  // The device exists but is not in the runtime-planned snapshot (e.g. a
  // picker-only / unmanaged device while the managed-device filter is active),
  // so a task on it would never be planned. Rejected rather than persisted.
  | 'device_not_planned'
  | 'device_not_eligible'
  | 'invalid_candidate'
  // The hardened write primitive refused to persist (suspected transient-empty
  // settings read while other tasks are live). Transient — the user can retry.
  | 'write_conflict'
  | 'unavailable';
