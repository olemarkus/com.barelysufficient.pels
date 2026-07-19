// Canonical wording for the retryable "the device-scoped objective write
// refused to persist" outcome. The write primitives refuse (rather than
// risk a clobber / fork) on a transient un-confirmable per-key migration or an
// untrustworthy settings absence read; the Flow cards throw this so Homey shows
// the user a retryable failure instead of a silent (false) success.
//
// Lives in shared-domain so the user-facing card error and any runtime log line
// emit identical text (`feedback_ui_text_shared_with_logs.md`) rather than
// drifting from an inline literal. Plain retry framing, no internal jargon.

export const OBJECTIVE_WRITE_REFUSED_RETRY = 'Couldn’t save just now — please try again.';

// Rejection line for the multi-home v1 scope gate (`device_in_sub_home`): the
// device belongs to a configured sub-home, and smart tasks only plan against
// the main home's meter budget, so creating/editing a task for it is refused.
// "separate meter" is the plain-language framing for a sub-home (a sub-home
// exists precisely to track a separately-metered budget); "yet" is honest
// about this being a v1 scope limit, not a permanent rule. No retry framing —
// retrying cannot succeed — and no internal jargon (`notes/ui-terminology.md`).
// Shared by the create widget, the settings-UI edit lane, the starvation-rescue
// surfaces, and the deadline Flow cards' thrown card error so every surface
// (and any runtime log breadcrumb) reads identically
// (`feedback_ui_text_shared_with_logs.md`). Lives HERE (not deadlineLabels.ts)
// so lean bundles like the rescue widget can import the line without dragging
// the full smart-task copy module in.
export const SMART_TASK_SUB_HOME_UNAVAILABLE
  = 'Smart tasks aren’t available yet for devices on a separate meter.';
