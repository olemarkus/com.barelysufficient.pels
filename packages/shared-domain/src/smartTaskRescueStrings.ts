// Canonical wording for the `allow_smart_task_rescue` Flow action card's
// run-listener rejections. Lives in shared-domain so the user-facing card error
// and any runtime log line emit identical text (Rule 4 / Rule 7,
// `notes/ui-terminology.md`) instead of drifting from an inline literal.

export const SMART_TASK_RESCUE_INVALID_PROPERTY = 'Choose what this smart task may do.';

export const SMART_TASK_RESCUE_INVALID_WHEN
  = 'Choose when this applies: at no time, or while the smart task is scheduled to run.';

export const SMART_TASK_RESCUE_MISSING_DEVICE = 'Device must be provided.';

export const SMART_TASK_RESCUE_NO_TASK = 'Add a smart task for this device first.';
