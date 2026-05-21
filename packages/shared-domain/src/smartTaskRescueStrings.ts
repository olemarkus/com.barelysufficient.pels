// Canonical wording for the `allow_smart_task_rescue` Flow action card's
// run-listener rejections. Lives in shared-domain so the user-facing card error
// and any runtime log line emit identical text (Rule 4 / Rule 7,
// `notes/ui-terminology.md`) instead of drifting from an inline literal.

export const SMART_TASK_RESCUE_INVALID_PROPERTY = 'Choose which rescue permission to set.';

export const SMART_TASK_RESCUE_INVALID_WHEN = 'Choose when this applies: never, or when the device is planned to run.';

export const SMART_TASK_RESCUE_MISSING_DEVICE = 'Device must be provided.';

export const SMART_TASK_RESCUE_NO_TASK = 'That device has no smart task yet — add a deadline first.';
