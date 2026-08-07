// Browser-safe contract for composing/editing a smart task (deferred
// objective) from a UI surface. The create_smart_task widget and the
// settings-UI smart-task edit lane share the SAME candidate request and
// reject vocabulary — both forward to the same app methods
// (`previewDeferredObjectivePlan`, `createDeferredObjective`), so the shapes
// live here (contract-homed) rather than widget-local. Type-only; imports
// nothing from `lib/`.

import type { DeferredObjectivePlanPreviewEstimate } from './deferredObjectivePlanPreview.js';
import type { DeferredObjectiveSettingsKind } from './deferredObjectiveSettings.js';

// The candidate the user is composing. `readyByLocalTime` is a 24-hour local
// "HH:mm" string; the server converts it to an absolute `deadlineAtMs` against
// the Homey timezone (DST-aware) so the browser never does timezone math.
export type SmartTaskCandidateRequest = {
  deviceId: string;
  kind: DeferredObjectiveSettingsKind;
  target: number;
  readyByLocalTime: string;
  // The absolute deadline the PREVIEW resolved and showed the user, echoed back
  // on create so the persisted task matches exactly what the preview promised.
  // Optional: absent for direct API callers (no preview step), in which case
  // the write re-resolves `readyByLocalTime` server-side as before. When present
  // it is validated (strictly future, within a sane horizon) and rejected with
  // `deadline_passed` if it has since slipped into the past — never silently
  // rolled to the next day. The server never trusts it as the persisted value
  // without that validation.
  deadlineAtMs?: number;
  // The "Extra permissions" for this task. `exemptFromBudget` lets it exceed the
  // soft daily budget; `limitLowerPriorityDevices` lets it limit lower-priority
  // devices; `pauseLowerPriorityDevices` lets it reserve the power it needs to
  // start. All are re-gated SERVER-side (the client's visibility is not
  // trusted): a NEW `limitLowerPriorityDevices` grant is dropped unless the
  // device is stepped-load eligible AND `exemptFromBudget` is also granted; an
  // ESTABLISHED limit grant survives every request except one that revokes the
  // stored `'always'` exemption it was paired with (the Flow card writes
  // limit-only grants verbatim and the runtime honours them, so an edit must
  // not erase one). The server maps an opted-in permission to the `'always'`
  // mode.
  //
  // ABSENT vs `false` is load-bearing, and the difference is PER KEY:
  //   - ABSENT says nothing about that permission — it keeps whatever the task
  //     already holds (granted elsewhere by the Flow card or the starvation
  //     rescue). The create widget omits a toggle that is off, so it stays
  //     additive without needing a lane of its own.
  //   - `false` REVOKES. The settings-UI editor sends all three explicitly, so
  //     an unchecked toggle actually takes the permission away.
  //   - `true` grants, at the mode it already stands at if it stands — so a
  //     boolean toggle can never promote a conditional `'at_risk'` grant.
  // The merge lives in `buildCandidateRescue`
  // (`lib/objectives/deferredObjectives/smartTaskCandidateRequest.ts`), which is
  // the single owner of it: callers persist its result verbatim rather than
  // re-deriving, so the preview and the write can't diverge. That module is also
  // where any runtime helper for this belongs — this package is TYPES-ONLY at
  // runtime (the Homey build sanitizer drops it from the bundle, so a value
  // export here crashes boot).
  exemptFromBudget?: boolean;
  limitLowerPriorityDevices?: boolean;
  pauseLowerPriorityDevices?: boolean;
};

export type SmartTaskWriteRejectReason =
  | 'invalid_request'
  | 'invalid_ready_by'
  // The previewed deadline the client echoed back on create has since slipped
  // into the past (or is implausibly far in the future). Rejected so the
  // persisted task can never disagree with the previewed window — the client
  // re-previews to resolve a fresh future deadline. Retryable.
  | 'deadline_passed'
  | 'device_not_found'
  // The device exists but is not in the runtime-planned snapshot (e.g. a
  // picker-only / unmanaged device while the managed-device filter is active),
  // so a task on it would never be planned. Rejected rather than persisted.
  | 'device_not_planned'
  | 'device_not_eligible'
  // The device belongs to a separate-meter sub-home; smart tasks are planned
  // against the main home's meter budget only (v1 scope), so the write is
  // rejected outright. NOT retryable — the surfaces show dedicated copy, never
  // the "try again" framing.
  | 'device_in_sub_home'
  | 'invalid_candidate'
  // The hardened write primitive refused to persist (suspected transient-empty
  // settings read while other tasks are live). Transient — the user can retry.
  | 'write_conflict'
  | 'unavailable';

// ─── Settings-UI smart-task edit lane (detail-page edit + clear) ─────────────
//
// Editing is a full re-create through the same validated app method the widget
// uses (`createDeferredObjective` → `upsertObjectiveForDevice`): the prior run
// is finalized to history as replaced and a fresh plan is seeded, while the
// run's `startedAtMs` baseline and any standing rescue permission survive.
// The edit lane additionally guards that a task EXISTS for the device, so an
// edit can never silently create a task that just ended.

export type SettingsUiSmartTaskRejectReason =
  | SmartTaskWriteRejectReason
  // The device has no active smart task to edit/clear (it completed, expired,
  // or was cleared elsewhere while the editor was open). The editor closes and
  // the surface refreshes rather than offering a retry.
  | 'task_not_found';

// Preview response: the priority-coordinated plan estimate plus the resolved
// deadline and pre-formatted local labels so the browser doesn't re-derive them.
export type SettingsUiSmartTaskPreviewResponse = {
  ok: true;
  deadlineAtMs: number;
  // "Tomorrow 07:00" / "Today 16:00" style label, resolved server-side in the
  // app timezone so the preview's window labels stay consistent with it.
  deadlineLabel: string;
  // The scheduled clock-hour window ("02:00–04:00" / "02:00, 03:00, 14:00"),
  // formatted SERVER-SIDE in the Homey timezone from `estimate.scheduledHours`.
  // Null when no hours are scheduled. Displayed verbatim so the window can
  // never drift into the phone's timezone when it differs from the Homey one.
  scheduledWindowLabel: string | null;
  estimate: DeferredObjectivePlanPreviewEstimate;
} | {
  ok: false;
  reason: SettingsUiSmartTaskRejectReason;
};

export type SettingsUiSmartTaskUpdateResponse = {
  ok: true;
} | {
  ok: false;
  reason: SettingsUiSmartTaskRejectReason;
};

export type SettingsUiSmartTaskCancelRequest = {
  deviceId: string;
};

export type SettingsUiSmartTaskCancelResponse = {
  ok: true;
} | {
  ok: false;
  reason: SettingsUiSmartTaskRejectReason;
};
