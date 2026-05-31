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
